from __future__ import annotations

import re
import unicodedata
from pathlib import Path

try:
    from mutagen import File as MutagenFile
except Exception:
    MutagenFile = None


# Yerel arşivde eksik Title etiketi bulunan, doğrulanmış albümler. Yeni
# eşleştirmeler bu listeye eklenir; kaynak ses dosyaları asla değiştirilmez.
CURATED_ALBUM_TRACKS = {
    "askin nur yengi gozumun bebegi": (
        "Öpeyim Geçsin", "Gözümün Bebeği", "Hayırlı Olsun", "Başka Sözüm Yok", "Tutmadın",
        "Yasak Elmam", "Bekleyenim Var", "Kibrit ve Alev", "Kahve Bahane", "Ayrı Gayrı",
    ),
}


def _catalog_key(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).replace("ı", "i")
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def _catalog_title_for_track(path: Path) -> str:
    match = re.fullmatch(r"(?:track|parca|parça|song)?[ ._-]*0*(\d+)", path.stem, flags=re.IGNORECASE)
    if not match:
        return ""
    index = int(match.group(1)) - 1
    folder_key = _catalog_key(path.parent.name)
    for album_key, titles in CURATED_ALBUM_TRACKS.items():
        if album_key in folder_key and 0 <= index < len(titles):
            return titles[index]
    return ""


def _is_generic_track_name(value: str) -> bool:
    return bool(re.fullmatch(r"(?:track|parca|parça|song)?[ ._-]*0*\d+", str(value or "").strip(), flags=re.IGNORECASE))


def _cue_track_metadata(path: Path) -> tuple[str, str]:
    """Read title/performer from a local CUE when an archive uses Track01 names."""
    track_match = re.fullmatch(r"(?:track|parca|parça|song)?[ ._-]*0*(\d+)", path.stem, flags=re.IGNORECASE)
    if not track_match:
        return "", ""
    wanted = int(track_match.group(1))
    for cue_path in path.parent.glob("*.cue"):
        try:
            lines = cue_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        album_artist = ""
        current = 0
        artist = ""
        title = ""
        for raw in lines:
            line = raw.strip()
            match = re.match(r'^PERFORMER\s+"?(.*?)"?$', line, re.IGNORECASE)
            if match:
                performer = match.group(1).strip()
                if current == wanted:
                    artist = performer
                elif not current:
                    album_artist = performer
                continue
            match = re.match(r"^TRACK\s+(\d+)", line, re.IGNORECASE)
            if match:
                current = int(match.group(1))
                continue
            if current == wanted:
                match = re.match(r'^TITLE\s+"?(.*?)"?$', line, re.IGNORECASE)
                if match:
                    title = match.group(1).strip()
        if title:
            return artist or album_artist, title
    return "", ""


def _folder_artist(path: Path) -> str:
    """Fallback for old 'Artist Diskografi/Album' archive folder layouts."""
    for candidate in (path.parent, *list(path.parents)[1:4]):
        folder = re.sub(r"\s*\([^)]*\)\s*$", "", candidate.name).strip()
        for separator in (" - ", " – ", " — "):
            if separator in folder:
                return folder.split(separator, 1)[0].strip()
        archive_match = re.split(r"\b(?:diskografi|discography|full\s+album(?:ler)?|alb[üu]mler?)\b", folder, maxsplit=1, flags=re.IGNORECASE)
        if len(archive_match) > 1 and archive_match[0].strip():
            return archive_match[0].strip(" -–—_ .")
    return ""


def artist_title_for_path(path: Path) -> tuple[str, str]:
    """Resolve the display/output Artist - Title without changing the source file."""
    artist = ""
    title = ""
    if MutagenFile is not None:
        try:
            tags = getattr(MutagenFile(path, easy=True), "tags", None) or {}
            artist = str((tags.get("artist") or tags.get("albumartist") or [""])[0]).strip()
            title = str((tags.get("title") or [""])[0]).strip()
        except Exception:
            pass
    if _is_generic_track_name(title):
        title = ""
    cue_artist, cue_title = _cue_track_metadata(path)
    artist = artist or cue_artist or _folder_artist(path)
    title = title or cue_title or _catalog_title_for_track(path)
    if not title:
        match = re.fullmatch(r"(?:track|parca|parça|song)?[ ._-]*0*(\d+)", path.stem, flags=re.IGNORECASE)
        title = f"Parça {int(match.group(1)):02d}" if match else re.sub(r"^\s*\d{1,4}\s*[.)_-]\s*", "", path.stem).strip()
    return artist, title


def display_name_for_path(path: Path) -> str:
    artist, title = artist_title_for_path(path)
    return f"{artist} - {title}" if artist and artist.casefold() not in title.casefold() else title


def duration_seconds_for_path(path: Path) -> int:
    """Best-effort local audio duration; never blocks browsing if a file is malformed."""
    if MutagenFile is None:
        return 0
    try:
        audio = MutagenFile(path)
        return max(0, int(round(float(getattr(getattr(audio, "info", None), "length", 0) or 0))))
    except Exception:
        return 0
