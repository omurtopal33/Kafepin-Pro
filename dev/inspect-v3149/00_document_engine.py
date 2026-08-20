from __future__ import annotations

from pathlib import Path
from collections import deque
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


A4_300 = (2480, 3508)


def _open_rgb(path: Path) -> Image.Image:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    return image


def _fit(image: Image.Image, box: tuple[int, int]) -> Image.Image:
    # thumbnail yalnız küçültür; kimlik kırpıldıktan sonra A4 alanını
    # doldurabilmesi için gerektiğinde büyütme de yapılır.
    ratio = min(box[0] / float(image.width), box[1] / float(image.height))
    size = (max(1, int(image.width * ratio)), max(1, int(image.height * ratio)))
    return image.resize(size, Image.Resampling.LANCZOS)


def _crop_identity_card(image: Image.Image) -> Image.Image:
    """Find the ID card on a mostly white flatbed scan without cropping normal pages."""
    source = image.copy()
    probe = ImageOps.grayscale(source)
    probe.thumbnail((900, 900), Image.Resampling.LANCZOS)
    width, height = probe.size
    if width < 80 or height < 80:
        return source

    # White scanner-bed/background pixels disappear. A small dilation joins the
    # photo/text/coloured regions that belong to one physical identity card.
    mask = probe.point(lambda value: 255 if value < 225 else 0)
    mask = mask.filter(ImageFilter.MaxFilter(9))
    pixels = mask.load()
    visited = bytearray(width * height)
    candidates: list[tuple[int, int, int, int, int]] = []

    for y in range(height):
        for x in range(width):
            index = y * width + x
            if visited[index] or pixels[x, y] == 0:
                continue
            visited[index] = 1
            queue = deque([(x, y)])
            area = 0
            left = right = x
            top = bottom = y
            touches_edge = False
            while queue:
                px, py = queue.popleft()
                area += 1
                left, right = min(left, px), max(right, px)
                top, bottom = min(top, py), max(bottom, py)
                if px == 0 or py == 0 or px == width - 1 or py == height - 1:
                    touches_edge = True
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if 0 <= nx < width and 0 <= ny < height:
                        next_index = ny * width + nx
                        if not visited[next_index] and pixels[nx, ny] != 0:
                            visited[next_index] = 1
                            queue.append((nx, ny))
            component_w, component_h = right - left + 1, bottom - top + 1
            ratio = component_w / float(component_h)
            # Kimlik cama dik veya yatay bırakılabilir; ikisini de kabul et.
            if not touches_edge and area >= 300 and 0.45 <= ratio <= 2.2:
                candidates.append((area, left, top, right, bottom))

    if not candidates:
        return source
    _, left, top, right, bottom = max(candidates, key=lambda value: value[0])
    scale_x = source.width / float(width)
    scale_y = source.height / float(height)
    # Kartın dışındaki tarayıcı zemini basılmasın; yalnızca çok küçük bir
    # güvenlik payı bırakılır ki kartın kenarı kırpılmasın.
    padding_x = max(5, int((right - left + 1) * 0.015))
    padding_y = max(5, int((bottom - top + 1) * 0.015))
    crop = (
        max(0, int((left - padding_x) * scale_x)),
        max(0, int((top - padding_y) * scale_y)),
        min(source.width, int((right + padding_x + 1) * scale_x)),
        min(source.height, int((bottom + padding_y + 1) * scale_y)),
    )
    # Kartın tarayıcıya bırakıldığı yön korunur. Böylece kullanıcı kartı dik
    # taradıysa çıktıdaki kimlik de dik, yatay taradıysa yatay görünür.
    return source.crop(crop)


def apply_adjustments(path: Path, *, rotate: int = 0, brightness: float = 1.0, contrast: float = 1.0, grayscale: bool = False) -> Path:
    image = _open_rgb(path)
    if rotate:
        image = image.rotate(-rotate, expand=True, fillcolor="white")
    if brightness != 1.0:
        image = ImageEnhance.Brightness(image).enhance(brightness)
    if contrast != 1.0:
        image = ImageEnhance.Contrast(image).enhance(contrast)
    if grayscale:
        image = ImageOps.grayscale(image).convert("RGB")
    image.save(path, "PNG", optimize=True)
    return path


def build_identity(front: Path, back: Path, layout: str, output_png: Path, output_pdf: Path) -> None:
    canvas = Image.new("RGB", A4_300, "white")
    cropped = [_crop_identity_card(_open_rgb(front)), _crop_identity_card(_open_rgb(back))]
    # 300 DPI'de gerçek kart ölçüsü 85,6 × 54 mm'dir. Tarama yönü korunarak
    # tek tek bu ölçüye oturtulur; sayfadaki boş tarayıcı alanı taşınmaz.
    cards = []
    for card in cropped:
        # Düz yataklı taramada kimliğin açık zeminli küçük yazıları silik
        # kalabiliyor. Yalnız kimlik çıktısında dengeli kontrast/keskinlik
        # uygula; normal belge taramasına dokunma.
        card = ImageOps.autocontrast(card, cutoff=0.3)
        card = ImageEnhance.Contrast(card).enhance(1.28)
        card = ImageEnhance.Sharpness(card).enhance(1.45)
        # Standart kart ölçüsünden %10 büyük: A4 üzerinde okunaklıdır ve iki
        # yüz aynı sayfaya güvenle sığar.
        target = (1112, 702) if card.width >= card.height else (702, 1112)
        cards.append(card.resize(target, Image.Resampling.LANCZOS))
    if layout == "vertical":
        gap = 140
        total_height = sum(card.height for card in cards) + gap
        top = (A4_300[1] - total_height) // 2
        positions = [((A4_300[0] - cards[0].width) // 2, top)]
        positions.append(((A4_300[0] - cards[1].width) // 2, top + cards[0].height + gap))
    else:
        gap = 140
        total_width = sum(card.width for card in cards) + gap
        left = (A4_300[0] - total_width) // 2
        positions = [(left, (A4_300[1] - cards[0].height) // 2)]
        positions.append((left + cards[0].width + gap, (A4_300[1] - cards[1].height) // 2))
    for card, position in zip(cards, positions):
        canvas.paste(card, position)
    output_png.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_png, "PNG", optimize=True)
    canvas.save(output_pdf, "PDF", resolution=300.0)


def build_normal(pages: list[Path], preview_png: Path, output_pdf: Path) -> None:
    if not pages:
        raise ValueError("Yazdırılacak veya kaydedilecek tarama yok.")
    rendered: list[Image.Image] = []
    margin = 120
    for path in pages:
        source = _open_rgb(path)
        page = Image.new("RGB", A4_300, "white")
        fitted = _fit(source, (A4_300[0] - 2 * margin, A4_300[1] - 2 * margin))
        page.paste(fitted, ((A4_300[0] - fitted.width) // 2, (A4_300[1] - fitted.height) // 2))
        rendered.append(page)
    rendered[0].save(preview_png, "PNG", optimize=True)
    rendered[0].save(output_pdf, "PDF", resolution=300.0, save_all=True, append_images=rendered[1:])


def build_photo_sheet(images: list[Path], paper: str, template: int, fit_mode: str, preview_png: Path, output_pdf: Path) -> None:
    if not images:
        raise ValueError("Önce en az bir resim tara.")
    page_size = (1748, 2480) if paper == "A5" else A4_300
    template = template if template in {1, 2, 4, 6, 8, 10, 12} else 4
    columns, rows = {1: (1, 1), 2: (2, 1), 4: (2, 2), 6: (2, 3), 8: (2, 4), 10: (2, 5), 12: (3, 4)}[template]
    margin, gap = 80, 36
    slot_w = (page_size[0] - 2 * margin - (columns - 1) * gap) // columns
    slot_h = (page_size[1] - 2 * margin - (rows - 1) * gap) // rows
    rendered: list[Image.Image] = []
    for start in range(0, len(images), template):
        page = Image.new("RGB", page_size, "white")
        for number, source in enumerate(images[start:start + template]):
            image = _open_rgb(source)
            if fit_mode == "fill":
                ratio = max(slot_w / image.width, slot_h / image.height)
                resized = image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)
                left, top = (resized.width - slot_w) // 2, (resized.height - slot_h) // 2
                image = resized.crop((left, top, left + slot_w, top + slot_h))
            else:
                image = _fit(image, (slot_w, slot_h))
            col, row = number % columns, number // columns
            x, y = margin + col * (slot_w + gap), margin + row * (slot_h + gap)
            page.paste(image, (x + (slot_w - image.width) // 2, y + (slot_h - image.height) // 2))
        rendered.append(page)
    rendered[0].save(preview_png, "PNG", optimize=True)
    rendered[0].save(output_pdf, "PDF", resolution=300.0, save_all=True, append_images=rendered[1:])
