from __future__ import annotations

import re


def _replace(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def patch_desktop_source(source: bytes) -> bytes:
    text = source.decode("utf-8-sig")

    text = _replace(
        text,
        "        private bool serverWasUnavailable;\n",
        "        private bool serverWasUnavailable;\n"
        "        private int serverConsecutiveHealthMisses;\n",
        "desktop watchdog consecutive-miss state",
    )
    text = _replace(
        text,
        "            serverWatchTimer.Interval = 1500;\n",
        "            serverWatchTimer.Interval = 3500;\n",
        "desktop watchdog interval",
    )
    text = _replace(
        text,
        '            string marker = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "KafePinPro", "pro-services-started.marker");\n',
        '            string marker = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KafePinPro", "pro-services-started.marker");\n',
        "per-user PRO startup marker",
    )
    text = _replace(
        text,
        "                BeginInitialize();\n                serverWatchTimer.Start();\n",
        "                BeginInitialize();\n                EnsureProServicesReadyAtStartupAsync();\n                serverWatchTimer.Start();\n",
        "non-blocking PRO startup from form shown",
    )
    text = _replace(
        text,
        "            bool allReady = mp3Ready && printerReady && serviceReady && clientReady && cvReady;\n",
        "            bool allReady = mp3Ready && printerReady && serviceReady && clientReady && performanceReady && cvReady;\n",
        "all installed PRO services readiness",
    )
    text = _replace(
        text,
        "        private async Task<bool> WaitForCvProAsync(int maxSeconds)\n",
        "        private async Task<bool> WaitForClientPerformanceAsync(int maxSeconds)\n"
        "        {\n"
        "            DateTime deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, maxSeconds));\n"
        "            while (DateTime.UtcNow < deadline)\n"
        "            {\n"
        "                if (await IsClientPerformanceReadyAsync()) return true;\n"
        "                await Task.Delay(500);\n"
        "            }\n"
        "            return await IsClientPerformanceReadyAsync();\n"
        "        }\n\n"
        "        private async Task<bool> WaitForCvProAsync(int maxSeconds)\n",
        "Client Performance bounded readiness wait",
    )
    text = _replace(
        text,
        "            Task<bool> performanceReadyTask = performanceStarted ? IsClientPerformanceReadyAsync() : Task.FromResult(false);\n",
        "            Task<bool> performanceReadyTask = performanceStarted ? WaitForClientPerformanceAsync(35) : Task.FromResult(false);\n",
        "Client Performance readiness task",
    )
    text = _replace(
        text,
        "                if (version == null)\n"
        "                {\n"
        "                    if (!serverWasUnavailable)\n",
        "                if (version == null)\n"
        "                {\n"
        "                    serverConsecutiveHealthMisses++;\n"
        "                    if (serverConsecutiveHealthMisses < 3) return;\n"
        "                    if (!serverWasUnavailable)\n",
        "desktop watchdog threshold",
    )
    text = _replace(
        text,
        "                bool versionChanged = !string.IsNullOrWhiteSpace(lastServerVersion) &&\n",
        "                serverConsecutiveHealthMisses = 0;\n"
        "\n"
        "                bool versionChanged = !string.IsNullOrWhiteSpace(lastServerVersion) &&\n",
        "desktop watchdog reset",
    )
    text = _replace(
        text,
        "                    req.Timeout = 900;\n"
        "                    req.ReadWriteTimeout = 900;\n"
        "                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);\n"
        "                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())\n"
        "                    {\n"
        "                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return null;\n"
        "                        return resp.Headers[\"X-KafePin-Version\"] ?? string.Empty;\n",
        "                    req.Timeout = 5000;\n"
        "                    req.ReadWriteTimeout = 5000;\n"
        "                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);\n"
        "                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())\n"
        "                    {\n"
        "                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return null;\n"
        "                        return resp.Headers[\"X-KafePin-Version\"] ?? string.Empty;\n",
        "desktop watchdog health timeout",
    )

    text = _replace(
        text,
        '        private const string PrinterProRoot = @"C:\\KafePinPro\\YaziciPRO";\n',
        '        private const string PrinterProRoot = @"C:\\KafePinPro\\YaziciPRO";\n'
        '        private const string EdevletHomeUrl = "https://www.turkiye.gov.tr/";\n'
        '        private const string EdevletProfileName = "WebView2Profile-eDevlet";\n',
        "e-Devlet constants",
    )
    text = _replace(
        text,
        "        private readonly WebView2 printerBrowser;\n",
        "        private readonly WebView2 printerBrowser;\n"
        "        private readonly WebView2 edevletBrowser;\n"
        "        private readonly TabControl printerTabs;\n"
        "        private readonly Panel printerTabsHeaderFill;\n"
        "        private readonly TabPage printerPanelTab;\n"
        "        private readonly TabPage edevletTab;\n"
        "        private readonly NumericUpDown edevletFeeBox;\n"
        "        private readonly ComboBox edevletPaymentBox;\n"
        "        private readonly Label edevletPricingState;\n",
        "e-Devlet controls",
    )
    text = _replace(
        text,
        "        private bool printerBrowserReady;\n",
        "        private bool printerBrowserReady;\n"
        "        private bool edevletBrowserReady;\n"
        "        private Task<CoreWebView2Environment> edevletEnvironmentTask;\n"
        "        private bool edevletServiceCharged;\n"
        "        private bool edevletChargeInProgress;\n"
        "        private bool edevletPricingLoaded;\n"
        "        private bool edevletTotalRefreshBusy;\n"
        "        private bool edevletLoginObserved;\n"
        "        private string edevletPendingTransactionId = string.Empty;\n",
        "e-Devlet state",
    )
    text = _replace(
        text,
        "        private readonly System.Windows.Forms.Timer messagingBadgeTimer;\n",
        "        private readonly System.Windows.Forms.Timer messagingBadgeTimer;\n"
        "        private readonly System.Windows.Forms.Timer edevletTotalTimer;\n",
        "e-Devlet live total timer field",
    )
    text = _replace(
        text,
        "            messagingBadgeTimer.Tick += MessagingBadgeTimer_Tick;\n",
        "            messagingBadgeTimer.Tick += MessagingBadgeTimer_Tick;\n\n"
        "            edevletTotalTimer = new System.Windows.Forms.Timer();\n"
        "            edevletTotalTimer.Interval = 1500;\n"
        "            edevletTotalTimer.Tick += async delegate { await RefreshEdevletSessionTotalAsync(); };\n",
        "e-Devlet live total timer initialization",
    )
    text = _replace(
        text,
        "                messagingBadgeTimer.Start();\n",
        "                messagingBadgeTimer.Start();\n"
        "                edevletTotalTimer.Start();\n",
        "e-Devlet live total timer start",
    )
    text = _replace(
        text,
        "try { messagingBadgeTimer.Stop(); } catch { }",
        "try { messagingBadgeTimer.Stop(); } catch { } try { edevletTotalTimer.Stop(); } catch { }",
        "e-Devlet live total timer stop",
    )
    text = _replace(
        text,
        "            printerBrowser = new WebView2();\n"
        "            printerBrowser.Dock = DockStyle.Fill;\n"
        "            printerBrowser.Visible = false;\n"
        "            contentPanel.Controls.Add(printerBrowser);\n",
        "            printerTabs = new TabControl();\n"
        "            printerTabs.Dock = DockStyle.Fill;\n"
        "            printerTabs.Visible = false;\n"
        "            printerTabs.Font = new Font(\"Segoe UI\", 10F);\n"
        "            printerPanelTab = new TabPage(\"Yazıcı Paneli\");\n"
        "            edevletTab = new TabPage(\"e-Devlet / Resmî Belgeler\");\n"
        "            printerBrowser = new WebView2();\n"
        "            printerBrowser.Dock = DockStyle.Fill;\n"
        "            printerBrowser.Visible = true;\n"
        "            printerPanelTab.Controls.Add(printerBrowser);\n"
        "            TableLayoutPanel edevletLayout = new TableLayoutPanel();\n"
        "            edevletLayout.Dock = DockStyle.Fill; edevletLayout.Margin = Padding.Empty; edevletLayout.Padding = Padding.Empty;\n"
        "            edevletLayout.ColumnCount = 1; edevletLayout.RowCount = 3;\n"
        "            edevletLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));\n"
        "            edevletLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44F));\n"
        "            edevletLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44F));\n"
        "            edevletLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));\n"
        "            edevletTab.Padding = Padding.Empty; edevletTab.Controls.Add(edevletLayout);\n"
        "            edevletBrowser = new WebView2();\n"
        "            edevletBrowser.Dock = DockStyle.Fill;\n"
        "            edevletBrowser.Margin = Padding.Empty;\n"
        "            edevletBrowser.DefaultBackgroundColor = Color.FromArgb(11, 20, 29);\n"
        "            edevletBrowser.Visible = true;\n"
        "            edevletLayout.Controls.Add(edevletBrowser, 0, 2);\n"
        "            FlowLayoutPanel edevletPricingBar = new FlowLayoutPanel();\n"
        "            edevletPricingBar.Dock = DockStyle.Fill; edevletPricingBar.Margin = Padding.Empty; edevletPricingBar.WrapContents = false; edevletPricingBar.AutoScroll = true; edevletPricingBar.Padding = new Padding(6, 5, 6, 4);\n"
        "            FlowLayoutPanel edevletToolbar = new FlowLayoutPanel();\n"
        "            edevletToolbar.Dock = DockStyle.Fill; edevletToolbar.Margin = Padding.Empty; edevletToolbar.WrapContents = false; edevletToolbar.AutoScroll = true; edevletToolbar.Padding = new Padding(6, 5, 6, 4);\n"
        "            Button edevletHome = new Button(); edevletHome.Text = \"e-Devlet Ana\"; edevletHome.Width = 105; edevletHome.Height = 32;\n"
        "            Button nufus = new Button(); nufus.Text = \"Nüfus Kayıt Örneği\"; nufus.Width = 145; nufus.Height = 32;\n"
        "            Button ikamet = new Button(); ikamet.Text = \"İkametgâh\"; ikamet.Width = 105; ikamet.Height = 32;\n"
        "            Button adli = new Button(); adli.Text = \"Adli Sicil\"; adli.Width = 105; adli.Height = 32;\n"
        "            Button sgk = new Button(); sgk.Text = \"SGK Dökümü\"; sgk.Width = 112; sgk.Height = 32;\n"
        "            Button ogrenci = new Button(); ogrenci.Text = \"Öğrenci Belgesi\"; ogrenci.Width = 125; ogrenci.Height = 32;\n"
        "            Button askerlik = new Button(); askerlik.Text = \"Askerlik Durum\"; askerlik.Width = 125; askerlik.Height = 32;\n"
        "            Button mezun = new Button(); mezun.Text = \"Mezun Belgesi\"; mezun.Width = 118; mezun.Height = 32;\n"
        "            Button emekli = new Button(); emekli.Text = \"Emekli Aylık ▾\"; emekli.Width = 118; emekli.Height = 32;\n"
        "            Button iskur = new Button(); iskur.Text = \"İŞKUR Kayıt\"; iskur.Width = 110; iskur.Height = 32;\n"
        "            Button myk = new Button(); myk.Text = \"MYK Belgesi\"; myk.Width = 105; myk.Height = 32;\n"
        "            Button vergi = new Button(); vergi.Text = \"Vergi Borç Yazısı\"; vergi.Width = 135; vergi.Height = 32;\n"
        "            Label feeLabel = new Label(); feeLabel.Text = \"Hizmet ₺\"; feeLabel.AutoSize = true; feeLabel.ForeColor = Color.White; feeLabel.Margin = new Padding(10, 9, 2, 0);\n"
        "            edevletFeeBox = new NumericUpDown(); edevletFeeBox.Minimum = 0; edevletFeeBox.Maximum = 10000; edevletFeeBox.DecimalPlaces = 2; edevletFeeBox.Width = 82; edevletFeeBox.Height = 30; edevletFeeBox.Margin = new Padding(0, 5, 4, 0);\n"
        "            edevletPaymentBox = new ComboBox(); edevletPaymentBox.Width = 82; edevletPaymentBox.DropDownStyle = ComboBoxStyle.DropDownList; edevletPaymentBox.Items.Add(\"NAKİT\"); edevletPaymentBox.Items.Add(\"KART\"); edevletPaymentBox.SelectedIndex = 0; edevletPaymentBox.Margin = new Padding(0, 5, 4, 0);\n"
        "            Button edevletSavePrice = new Button(); edevletSavePrice.Text = \"Fiyatı Kaydet\"; edevletSavePrice.Width = 112; edevletSavePrice.Height = 32;\n"
        "            Button edevletCharge = new Button(); edevletCharge.Text = \"KafePin'e İşle\"; edevletCharge.Width = 125; edevletCharge.Height = 32;\n"
        "            Button edevletCancelCharge = new Button(); edevletCancelCharge.Text = \"İptal (-1 Çıktı)\"; edevletCancelCharge.Width = 125; edevletCancelCharge.Height = 32;\n"
        "            Button edevletDeleteCharge = new Button(); edevletDeleteCharge.Text = \"Sil\"; edevletDeleteCharge.Width = 62; edevletDeleteCharge.Height = 32;\n"
        "            Button endSession = new Button(); endSession.Text = \"Oturumu Bitir\"; endSession.Width = 118; endSession.Height = 32;\n"
        "            edevletPricingState = new Label(); edevletPricingState.Text = \"Ücret bekliyor\"; edevletPricingState.AutoSize = true; edevletPricingState.ForeColor = Color.FromArgb(200, 214, 225); edevletPricingState.Margin = new Padding(8, 9, 0, 0);\n"
        "            printerPanelTab.BackColor = Color.FromArgb(11, 20, 29); edevletTab.BackColor = Color.FromArgb(11, 20, 29);\n"
        "            edevletPricingBar.BackColor = Color.FromArgb(15, 29, 41); edevletToolbar.BackColor = Color.FromArgb(15, 29, 41);\n"
        "            foreach (Button toolButton in new Button[] { edevletHome, nufus, ikamet, adli, sgk, ogrenci, askerlik, mezun, emekli, iskur, myk, vergi, edevletSavePrice, edevletCharge, edevletCancelCharge, edevletDeleteCharge, endSession })\n"
        "            {\n"
        "                toolButton.FlatStyle = FlatStyle.Flat; toolButton.FlatAppearance.BorderSize = 1;\n"
        "                toolButton.FlatAppearance.BorderColor = Color.FromArgb(55, 82, 103);\n"
        "                toolButton.BackColor = Color.FromArgb(24, 42, 58); toolButton.ForeColor = Color.White;\n"
        "                toolButton.Font = new Font(\"Segoe UI\", 9F, FontStyle.Bold); toolButton.Cursor = Cursors.Hand;\n"
        "            }\n"
        "            edevletHome.BackColor = Color.FromArgb(24, 142, 98); edevletHome.FlatAppearance.BorderColor = Color.FromArgb(70, 220, 160);\n"
        "            edevletCharge.BackColor = Color.FromArgb(24, 142, 98); edevletCharge.FlatAppearance.BorderColor = Color.FromArgb(70, 220, 160);\n"
        "            endSession.BackColor = Color.FromArgb(123, 37, 53); endSession.FlatAppearance.BorderColor = Color.FromArgb(218, 78, 102);\n"
        "            edevletHome.Click += async delegate { await OpenEdevletUrlAsync(EdevletHomeUrl); };\n"
        "            nufus.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/nvi-nufus-kayit-ornegi-belgesi-sorgulama\"); };\n"
        "            ikamet.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/nvi-yerlesim-yeri-ve-diger-adres-belgesi-sorgulama\"); };\n"
        "            adli.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/adli-sicil-kaydi\"); };\n"
        "            sgk.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/sgk-tescil-ve-hizmet-dokumu\"); };\n"
        "            ogrenci.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/yok-ogrenci-belgesi-sorgulama\"); };\n"
        "            askerlik.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/mill-savunma-askerligim\"); };\n"
        "            mezun.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/yuksekogretim-mezun-belgesi-sorgulama\"); };\n"
        "            ContextMenuStrip emekliMenu = new ContextMenuStrip();\n"
        "            ToolStripMenuItem emekli4A = new ToolStripMenuItem(\"4A Emekli Aylık Bilgisi\"); ToolStripMenuItem emekli4B = new ToolStripMenuItem(\"4B Emekli Aylık Bilgisi\"); ToolStripMenuItem emekli4C = new ToolStripMenuItem(\"4C Emekli Aylık Bilgisi\");\n"
        "            emekliMenu.Items.Add(emekli4A); emekliMenu.Items.Add(emekli4B); emekliMenu.Items.Add(emekli4C);\n"
        "            emekli4A.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/4a-emekli-aylik-bilgisi\"); };\n"
        "            emekli4B.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/4b-emekli-aylik-bilgisi\"); };\n"
        "            emekli4C.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/4c-emekli-aylik-bilgisi\"); };\n"
        "            emekli.Click += delegate { emekliMenu.Show(emekli, new Point(0, emekli.Height)); };\n"
        "            iskur.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/iskur-kayit-belgesi\"); };\n"
        "            myk.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/myk-mesleki-yeterlilik-belgesi-sorgulama\"); };\n"
        "            vergi.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/gib-borc-durum-yazisi-talep-girisi-gercek-kisi\"); };\n"
        "            edevletSavePrice.Click += async delegate { await SaveEdevletPricingConfigAsync(true); };\n"
        "            edevletCharge.Click += async delegate { await EnsureEdevletServiceChargedAsync(); };\n"
        "            edevletCancelCharge.Click += async delegate { await ClosePendingEdevletChargeAsync(false); };\n"
        "            edevletDeleteCharge.Click += async delegate { await ClosePendingEdevletChargeAsync(true); };\n"
        "            endSession.Click += async delegate { await ClearEdevletSessionAsync(); };\n"
        "            edevletPricingBar.Controls.Add(feeLabel); edevletPricingBar.Controls.Add(edevletFeeBox); edevletPricingBar.Controls.Add(edevletPaymentBox); edevletPricingBar.Controls.Add(edevletSavePrice); edevletPricingBar.Controls.Add(edevletCharge); edevletPricingBar.Controls.Add(edevletCancelCharge); edevletPricingBar.Controls.Add(edevletDeleteCharge); edevletPricingBar.Controls.Add(edevletPricingState);\n"
        "            edevletToolbar.Controls.Add(edevletHome); edevletToolbar.Controls.Add(nufus); edevletToolbar.Controls.Add(ikamet); edevletToolbar.Controls.Add(adli); edevletToolbar.Controls.Add(sgk); edevletToolbar.Controls.Add(ogrenci); edevletToolbar.Controls.Add(askerlik); edevletToolbar.Controls.Add(mezun); edevletToolbar.Controls.Add(emekli); edevletToolbar.Controls.Add(iskur); edevletToolbar.Controls.Add(myk); edevletToolbar.Controls.Add(vergi); edevletToolbar.Controls.Add(endSession);\n"
        "            edevletLayout.Controls.Add(edevletPricingBar, 0, 0); edevletLayout.Controls.Add(edevletToolbar, 0, 1);\n"
        "            printerTabs.TabPages.Add(printerPanelTab);\n"
        "            printerTabs.TabPages.Add(edevletTab);\n"
        "            printerTabs.SelectedIndexChanged += async delegate { if (printerTabs.SelectedTab == edevletTab) { try { await EnsureEdevletBrowserAsync(); await LoadEdevletPricingConfigAsync(); } catch (Exception ex) { MessageBox.Show(\"e-Devlet açılamadı:\\n\" + ex.Message, \"KafePin e-Devlet\", MessageBoxButtons.OK, MessageBoxIcon.Error); } } };\n"
        "            contentPanel.Controls.Add(printerTabs);\n"
        "            printerTabsHeaderFill = new Panel();\n"
        "            printerTabsHeaderFill.BackColor = Color.FromArgb(11, 20, 29);\n"
        "            printerTabsHeaderFill.SetBounds(420, 0, Math.Max(0, contentPanel.ClientSize.Width - 420), 36);\n"
        "            printerTabsHeaderFill.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;\n"
        "            printerTabsHeaderFill.Visible = false;\n"
        "            contentPanel.Controls.Add(printerTabsHeaderFill);\n",
        "printer tabs construction",
    )
    text = _replace(
        text,
        "try { printerBrowser.Dispose(); } catch { }",
        "try { printerBrowser.Dispose(); } catch { } try { edevletBrowser.Dispose(); } catch { }",
        "e-Devlet dispose",
    )
    text = _replace(
        text,
        "            printerTabs.Font = new Font(\"Segoe UI\", 10F);\n",
        "            printerTabs.Font = new Font(\"Segoe UI\", 10F, FontStyle.Bold);\n"
        "            printerTabs.DrawMode = TabDrawMode.OwnerDrawFixed;\n"
        "            printerTabs.SizeMode = TabSizeMode.Fixed;\n"
        "            printerTabs.ItemSize = new Size(210, 34);\n"
        "            printerTabs.DrawItem += delegate(object sender, DrawItemEventArgs e)\n"
        "            {\n"
        "                bool selected = (e.State & DrawItemState.Selected) == DrawItemState.Selected;\n"
        "                Color tabBack = selected ? Color.FromArgb(24, 142, 98) : Color.FromArgb(24, 42, 58);\n"
        "                Color tabBorder = selected ? Color.FromArgb(70, 220, 160) : Color.FromArgb(55, 82, 103);\n"
        "                Rectangle tabRect = e.Bounds; tabRect.Inflate(-1, -1);\n"
        "                using (SolidBrush fill = new SolidBrush(tabBack)) e.Graphics.FillRectangle(fill, tabRect);\n"
        "                using (Pen border = new Pen(tabBorder)) e.Graphics.DrawRectangle(border, tabRect);\n"
        "                TextRenderer.DrawText(e.Graphics, printerTabs.TabPages[e.Index].Text, printerTabs.Font, tabRect, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);\n"
        "            };\n",
        "themed Yazici PRO tabs",
    )
    old_show = """        private void ShowPrinterView()
        {
            mp3ViewActive = false;
            printerViewActive = true;
            serviceViewActive = false;
            clientViewActive = false;
            splash.Visible = false;
            browser.Visible = false;
            mp3Browser.Visible = false;
            serviceBrowser.Visible = false;
            clientBrowser.Visible = false;
            clientPerformanceBrowser.Visible = false;
            printerBrowser.Visible = true;
            printerBrowser.BringToFront();
            UpdateNavButtons(PrinterProUrl);
            KeepWhatsAppSidebarOnTop();
        }
"""
    new_show = """        private void ShowPrinterView()
        {
            mp3ViewActive = false;
            printerViewActive = true;
            serviceViewActive = false;
            clientViewActive = false;
            splash.Visible = false;
            browser.Visible = false;
            mp3Browser.Visible = false;
            serviceBrowser.Visible = false;
            clientBrowser.Visible = false;
            clientPerformanceBrowser.Visible = false;
            printerBrowser.Visible = true;
            edevletBrowser.Visible = true;
            printerTabs.Visible = true;
            printerTabs.BringToFront();
            printerTabsHeaderFill.Visible = true;
            printerTabsHeaderFill.BringToFront();
            UpdateNavButtons(printerTabs.SelectedTab == edevletTab ? EdevletHomeUrl : PrinterProUrl);
            KeepWhatsAppSidebarOnTop();
        }
"""
    text = _replace(text, old_show, new_show, "ShowPrinterView")

    anchor = "        private async void PrinterCoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)\n"
    methods = r'''        private Task<CoreWebView2Environment> GetEdevletEnvironmentAsync()
        {
            if (edevletEnvironmentTask == null)
            {
                string userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KafePinPro", EdevletProfileName);
                Directory.CreateDirectory(userData);
                edevletEnvironmentTask = CoreWebView2Environment.CreateAsync(null, userData);
            }
            return edevletEnvironmentTask;
        }

        private static async Task<string> PostYaziciRevenueJsonAsync(string path, string json, int timeoutMs = 5000)
        {
            return await Task.Run(delegate
            {
                byte[] body = Encoding.UTF8.GetBytes(json);
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:17893" + path);
                req.Method = "POST"; req.ContentType = "application/json"; req.ContentLength = body.Length;
                req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs;
                using (Stream stream = req.GetRequestStream()) stream.Write(body, 0, body.Length);
                using (HttpWebResponse response = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    string result = reader.ReadToEnd();
                    if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300 || result.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) < 0)
                        throw new InvalidOperationException("Yazıcı Gelir servisi işlemi reddetti: " + result);
                    return result;
                }
            });
        }

        private static async Task<string> GetYaziciRevenueJsonAsync(string path)
        {
            return await Task.Run(delegate
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:17893" + path);
                req.Method = "GET"; req.Timeout = 4000; req.ReadWriteTimeout = 4000;
                using (HttpWebResponse response = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream())) return reader.ReadToEnd();
            });
        }

        private async Task LoadEdevletPricingConfigAsync()
        {
            if (edevletPricingLoaded) return;
            try
            {
                string json = await GetYaziciRevenueJsonAsync("/config");
                System.Text.RegularExpressions.Match priceMatch = System.Text.RegularExpressions.Regex.Match(json, "\"price_edevlet\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                decimal price;
                if (priceMatch.Success && decimal.TryParse(priceMatch.Groups[1].Value, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out price))
                    edevletFeeBox.Value = Math.Max(edevletFeeBox.Minimum, Math.Min(edevletFeeBox.Maximum, price));
                edevletPaymentBox.SelectedIndex = json.IndexOf("\"payment_method\":\"CARD\"", StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : 0;
                edevletPricingLoaded = true;
                edevletPricingState.Text = edevletFeeBox.Value > 0 ? "Kayıtlı ücret hazır" : "Ücreti girip kaydet";
                await ResumeEdevletActiveSessionAsync();
            }
            catch (Exception ex) { edevletPricingState.Text = "Fiyat okunamadı: " + ex.Message; }
        }

        private async Task<bool> SaveEdevletPricingConfigAsync(bool notify)
        {
            try
            {
                string amount = edevletFeeBox.Value.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);
                string payment = edevletPaymentBox.SelectedIndex == 1 ? "CARD" : "CASH";
                await PostYaziciRevenueJsonAsync("/config", "{\"price_edevlet\":" + amount + ",\"payment_method\":\"" + payment + "\"}");
                edevletPricingLoaded = true; edevletPricingState.Text = "Fiyat kaydedildi";
                if (notify) MessageBox.Show("e-Devlet hizmet bedeli kaydedildi.", "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return true;
            }
            catch (Exception ex)
            {
                edevletPricingState.Text = "Fiyat kaydedilemedi";
                MessageBox.Show("e-Devlet hizmet bedeli kaydedilemedi:\n" + ex.Message, "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
        }

        private async Task ResumeEdevletActiveSessionAsync()
        {
            try
            {
                string json = await GetYaziciRevenueJsonAsync("/edevlet/session/active");
                System.Text.RegularExpressions.Match idMatch = System.Text.RegularExpressions.Regex.Match(json, "\"id\"\\s*:\\s*\"([^\"]+)\"", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (idMatch.Success) edevletPendingTransactionId = idMatch.Groups[1].Value;
                await RefreshEdevletSessionTotalAsync();
            }
            catch { }
        }

        private async Task RefreshEdevletSessionTotalAsync()
        {
            if (edevletTotalRefreshBusy || string.IsNullOrWhiteSpace(edevletPendingTransactionId) || printerTabs.SelectedTab != edevletTab) return;
            edevletTotalRefreshBusy = true;
            try
            {
                string json = await GetYaziciRevenueJsonAsync("/transaction?id=" + Uri.EscapeDataString(edevletPendingTransactionId));
                System.Text.RegularExpressions.Match totalMatch = System.Text.RegularExpressions.Regex.Match(json, "\"total\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                decimal total;
                if (totalMatch.Success && decimal.TryParse(totalMatch.Groups[1].Value, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out total))
                {
                    edevletPricingState.Text = "Oturum toplamı: " + total.ToString("0.00") + " ₺ • baskılar otomatik eklenir";
                    edevletPricingState.ForeColor = Color.FromArgb(70, 220, 160);
                }
            }
            catch { }
            finally { edevletTotalRefreshBusy = false; }
        }

        private async Task<bool> PrepareEdevletServiceChargeAsync()
        {
            if (edevletServiceCharged)
            {
                edevletPricingState.Text = "Bu müşteri için işlendi";
                return true;
            }
            if (edevletChargeInProgress)
            {
                edevletPricingState.Text = "Aktarım devam ediyor…";
                return false;
            }
            decimal fee = edevletFeeBox.Value;
            if (fee <= 0)
            {
                MessageBox.Show("Önce e-Devlet hizmet bedelini gir.", "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                edevletFeeBox.Focus();
                return false;
            }
            string payment = edevletPaymentBox.SelectedIndex == 1 ? "CARD" : "CASH";
            edevletChargeInProgress = true;
            try
            {
                if (!await SaveEdevletPricingConfigAsync(false)) return false;
                if (!string.IsNullOrWhiteSpace(edevletPendingTransactionId)) { edevletPricingState.Text = "Onay bekliyor • KafePin'e gönderilmedi"; return true; }
                string amount = fee.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);
                string prepared = await PostYaziciRevenueJsonAsync("/service/prepare", "{\"service_type\":\"edevlet\",\"quantity\":1,\"payment_method\":\"" + payment + "\",\"title\":\"e-Devlet Hizmet Bedeli\",\"amount\":" + amount + "}");
                System.Text.RegularExpressions.Match idMatch = System.Text.RegularExpressions.Regex.Match(prepared, "\"id\"\\s*:\\s*\"([^\"]+)\"", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (!idMatch.Success) throw new InvalidOperationException("Hizmet işlemi hazırlandı fakat işlem kimliği alınamadı.");
                edevletPendingTransactionId = idMatch.Groups[1].Value;
                edevletPricingState.Text = "Oturum toplamı: " + fee.ToString("0.00") + " ₺ • baskılar otomatik eklenir";
                edevletPricingState.ForeColor = Color.FromArgb(70, 220, 160);
                return true;
            }
            catch (Exception ex)
            {
                edevletPricingState.Text = "Hazırlama hatası";
                MessageBox.Show("e-Devlet hizmet bedeli hazırlanamadı:\n" + ex.Message, "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            finally { edevletChargeInProgress = false; }
        }

        private async Task<bool> EnsureEdevletServiceChargedAsync()
        {
            if (edevletServiceCharged) { edevletPricingState.Text = "Bu müşteri için işlendi"; return true; }
            if (string.IsNullOrWhiteSpace(edevletPendingTransactionId))
            {
                MessageBox.Show("Önce Ücreti Hazırla düğmesine bas. KafePin'e aktarım yalnız ayrı onaydan sonra yapılır.", "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return false;
            }
            if (edevletChargeInProgress) return false;
            edevletChargeInProgress = true;
            try
            {
                string payment = edevletPaymentBox.SelectedIndex == 1 ? "CARD" : "CASH";
                string safeId = edevletPendingTransactionId.Replace("\\", "\\\\").Replace("\"", "\\\"");
                await PostYaziciRevenueJsonAsync("/transaction/confirm", "{\"id\":\"" + safeId + "\",\"payment_method\":\"" + payment + "\"}");
                edevletServiceCharged = true; edevletFeeBox.Enabled = false; edevletPaymentBox.Enabled = false;
                edevletPricingState.Text = edevletFeeBox.Value.ToString("0.00") + " ₺ KafePin'e işlendi • bu oturumda tekrar eklenmez";
                return true;
            }
            catch (Exception ex)
            {
                edevletPricingState.Text = "Aktarım hatası • kayıt onay bekliyor";
                MessageBox.Show("e-Devlet hizmet bedeli KafePin'e işlenemedi:\n" + ex.Message, "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            finally { edevletChargeInProgress = false; }
        }

        private async Task ClosePendingEdevletChargeAsync(bool delete)
        {
            if (edevletServiceCharged) { MessageBox.Show("Bu hizmet bedeli zaten KafePin'e işlendi; iptal veya silme yapılamaz.", "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            if (string.IsNullOrWhiteSpace(edevletPendingTransactionId)) { edevletPricingState.Text = "Onay bekleyen ücret yok"; return; }
            if (edevletChargeInProgress) return;
            edevletChargeInProgress = true;
            try
            {
                string safeId = edevletPendingTransactionId.Replace("\\", "\\\\").Replace("\"", "\\\"");
                string changed = await PostYaziciRevenueJsonAsync(delete ? "/transaction/delete" : "/edevlet/session/remove-print", "{\"id\":\"" + safeId + "\"}");
                if (delete) { edevletPendingTransactionId = string.Empty; edevletPricingState.Text = "Oturum silindi • KafePin'e gönderilmedi"; }
                else
                {
                    System.Text.RegularExpressions.Match totalMatch = System.Text.RegularExpressions.Regex.Match(changed, "\"total\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    decimal total;
                    edevletPricingState.Text = totalMatch.Success && decimal.TryParse(totalMatch.Groups[1].Value, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out total)
                        ? "1 çıktı iptal edildi • toplam: " + total.ToString("0.00") + " ₺"
                        : "1 çıktı iptal edildi";
                    edevletPricingState.ForeColor = Color.FromArgb(70, 220, 160);
                }
            }
            catch (Exception ex) { MessageBox.Show((delete ? "Silme" : "İptal") + " başarısız:\n" + ex.Message, "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { edevletChargeInProgress = false; }
        }

        private async Task PrintEdevletDocumentAsync()
        {
            if (edevletChargeInProgress) return;
            try
            {
                await EnsureEdevletBrowserAsync();
                if (!await PrepareEdevletServiceChargeAsync()) return;
                string snapshot = await GetYaziciRevenueJsonAsync("/snapshot");
                System.Text.RegularExpressions.Match recordMatch = System.Text.RegularExpressions.Regex.Match(snapshot, "\"record_id\"\\s*:\\s*([0-9]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                long afterRecordId = recordMatch.Success ? long.Parse(recordMatch.Groups[1].Value) : 0;
                await edevletBrowser.CoreWebView2.ExecuteScriptAsync("window.print();");
                string payment = edevletPaymentBox.SelectedIndex == 1 ? "CARD" : "CASH";
                string safeId = edevletPendingTransactionId.Replace("\\", "\\\\").Replace("\"", "\\\"");
                string claimed = await PostYaziciRevenueJsonAsync("/claim-after", "{\"after_record_id\":" + afterRecordId.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"service_type\":\"bw\",\"payment_method\":\"" + payment + "\",\"transaction_id\":\"" + safeId + "\"}", 130000);
                System.Text.RegularExpressions.Match totalMatch = System.Text.RegularExpressions.Regex.Match(claimed, "\"total\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                decimal total;
                edevletPricingState.Text = totalMatch.Success && decimal.TryParse(totalMatch.Groups[1].Value, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out total)
                    ? "Oturum toplamı: " + total.ToString("0.00") + " ₺ • iş bitince KafePin'e işle"
                    : "Çıktı oturum toplamına eklendi • iş bitince KafePin'e işle";
                edevletPricingState.ForeColor = Color.FromArgb(70, 220, 160);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Yazdırma tamamlanamadı veya çıktı ücreti oturuma eklenemedi:\n" + ex.Message, "KafePin e-Devlet", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task OpenEdevletUrlAsync(string url)
        {
            await EnsureEdevletBrowserAsync();
            if (IsEdevletUrl(url)) edevletBrowser.CoreWebView2.Navigate(url);
        }

        private async Task EnsureEdevletBrowserAsync()
        {
            if (edevletBrowserReady && edevletBrowser.CoreWebView2 != null) return;
            CoreWebView2Environment env = await GetEdevletEnvironmentAsync();
            await edevletBrowser.EnsureCoreWebView2Async(env);
            try { await edevletBrowser.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setAutoDarkModeOverride", "{\"enabled\":true}"); } catch { }
            edevletBrowser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            edevletBrowser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            edevletBrowser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            edevletBrowser.CoreWebView2.Settings.IsZoomControlEnabled = false;
            await EnableWebContentOutsideClickDismissAsync(edevletBrowser);
            edevletBrowser.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try { if (!string.IsNullOrWhiteSpace(e.Uri) && IsEdevletUrl(e.Uri)) edevletBrowser.CoreWebView2.Navigate(e.Uri); } catch { }
            };
            edevletBrowser.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                if (IsEdevletLoginUrl(e.Uri)) edevletLoginObserved = true;
                if (IsEdevletUrl(e.Uri)) return;
                e.Cancel = true;
            };
            edevletBrowser.NavigationCompleted += async delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                edevletBrowserReady = e.IsSuccess;
                if (e.IsSuccess)
                {
                    string currentUrl = edevletBrowser.Source == null ? EdevletHomeUrl : edevletBrowser.Source.ToString();
                    UpdateNavButtons(currentUrl);
                    if (IsEdevletLoginUrl(currentUrl)) edevletLoginObserved = true;
                    else if (edevletLoginObserved && string.IsNullOrWhiteSpace(edevletPendingTransactionId) && edevletFeeBox.Value > 0)
                    {
                        edevletLoginObserved = false;
                        await PrepareEdevletServiceChargeAsync();
                    }
                }
            };
            edevletBrowser.CoreWebView2.ProcessFailed += delegate { edevletBrowserReady = false; };
            edevletBrowser.Source = new Uri(EdevletHomeUrl);
            for (int i = 0; i < 100 && !edevletBrowserReady; i++) await Task.Delay(100);
            if (!edevletBrowserReady) throw new InvalidOperationException("e-Devlet WebView2 iç sekmesi yüklenemedi.");
        }

        private static bool IsEdevletUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
            return string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase) &&
                (string.Equals(uri.Host, "www.turkiye.gov.tr", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(uri.Host, "turkiye.gov.tr", StringComparison.OrdinalIgnoreCase) ||
                 uri.Host.EndsWith(".turkiye.gov.tr", StringComparison.OrdinalIgnoreCase));
        }

        private static bool IsEdevletLoginUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
            string host = (uri.Host ?? string.Empty).ToLowerInvariant();
            string path = (uri.AbsolutePath ?? string.Empty).ToLowerInvariant();
            return host == "giris.turkiye.gov.tr" || path.Contains("/giris/") || path.EndsWith("/giris");
        }

        private async Task ClearEdevletSessionAsync()
        {
            if (edevletBrowser.CoreWebView2 == null) return;
            try { await edevletBrowser.CoreWebView2.ExecuteScriptAsync("try{localStorage.clear();sessionStorage.clear();}catch(e){}"); } catch { }
            try { edevletBrowser.CoreWebView2.CookieManager.DeleteAllCookies(); } catch { }
            try { await edevletBrowser.CoreWebView2.CallDevToolsProtocolMethodAsync("Network.clearBrowserCache", "{}"); } catch { }
            try { await edevletBrowser.CoreWebView2.CallDevToolsProtocolMethodAsync("Network.clearBrowserCookies", "{}"); } catch { }
            try { edevletBrowser.Source = new Uri("about:blank"); } catch { }
            edevletBrowserReady = false;
            edevletServiceCharged = false; edevletChargeInProgress = false; edevletLoginObserved = false; edevletPendingTransactionId = string.Empty;
            edevletFeeBox.Enabled = true; edevletPaymentBox.Enabled = true; edevletPricingState.Text = "Yeni müşteri • kayıtlı ücret hazır";
        }

'''
    text = _replace(text, anchor, methods + anchor, "e-Devlet methods")
    text = _replace(
        text,
        "                    printerBrowser.Visible = true;\n                    printerBrowser.BringToFront();\n                    if (whatsAppViewActive && whatsAppPanel.Visible)\n                        whatsAppPanel.BringToFront();\n                    UpdateNavButtons(PrinterProUrl);\n",
        "                    printerTabs.Visible = true;\n                    printerTabs.BringToFront();\n                    printerTabsHeaderFill.Visible = true;\n                    printerTabsHeaderFill.BringToFront();\n                    if (whatsAppViewActive && whatsAppPanel.Visible)\n                        whatsAppPanel.BringToFront();\n                    UpdateNavButtons(PrinterProUrl);\n",
        "printer navigation completion",
    )
    text = _replace(
        text,
        "            if (IsPrinterProUrl(e.Uri))\n            {\n                printerBrowser.CoreWebView2.Navigate(e.Uri);\n                return;\n            }\n            OpenExternal(e.Uri);\n",
        "            if (IsPrinterProUrl(e.Uri))\n            {\n                printerBrowser.CoreWebView2.Navigate(e.Uri);\n                return;\n            }\n            return;\n",
        "printer popup isolation",
    )
    text = text.replace("            printerBrowser.Visible = false;\n", "            printerBrowser.Visible = false;\n            printerTabs.Visible = false;\n            printerTabsHeaderFill.Visible = false;\n")

    # v4.0.2's desktop shell still checked a retired fixed version literal in
    # IsPrinterProReadyOnceAsync.  That makes healthy newer services appear
    # dead after the component manager has started them. Keep the check
    # bounded, verify both loopback services, and derive the expected version
    # from the installed Yazici PRO metadata instead of a stale literal.
    dynamic_ready = r'''        private async Task<bool> IsPrinterProReadyOnceAsync()
        {
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PrinterProUrl + "api/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    req.Method = "GET"; req.Timeout = 1500; req.ReadWriteTimeout = 1500;
                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                    string printerVersion;
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (StreamReader rd = new StreamReader(resp.GetResponseStream()))
                    {
                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return false;
                        string isolation = resp.Headers["X-KafePin-Yazici-Isolation"] ?? string.Empty;
                        if (!string.Equals(isolation, "separate-loopback-service", StringComparison.OrdinalIgnoreCase)) return false;
                        string health = rd.ReadToEnd();
                        if (health.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) < 0) return false;
                        printerVersion = ReadHealthVersion(health);
                        if (string.IsNullOrWhiteSpace(printerVersion)) return false;
                    }

                    string installedVersion = ReadInstalledYaziciVersion();
                    if (!string.IsNullOrWhiteSpace(installedVersion) && !string.Equals(printerVersion, installedVersion, StringComparison.OrdinalIgnoreCase)) return false;

                    HttpWebRequest rev = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:17893/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    rev.Method = "GET"; rev.Timeout = 1500; rev.ReadWriteTimeout = 1500;
                    using (HttpWebResponse resp = (HttpWebResponse)rev.GetResponse())
                    using (StreamReader rd = new StreamReader(resp.GetResponseStream()))
                    {
                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return false;
                        string revenueVersion = ReadHealthVersion(rd.ReadToEnd());
                        return string.Equals(printerVersion, revenueVersion, StringComparison.OrdinalIgnoreCase);
                    }
                }
                catch { return false; }
            });
        }

        private static string ReadHealthVersion(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return string.Empty;
            System.Text.RegularExpressions.Match match = System.Text.RegularExpressions.Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]+)\"", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            return match.Success ? match.Groups[1].Value.Trim() : string.Empty;
        }

        private static string ReadInstalledYaziciVersion()
        {
            try
            {
                string path = Path.Combine(PrinterProRoot, "yazici-pro-version.json");
                if (!File.Exists(path)) return string.Empty;
                return ReadHealthVersion(File.ReadAllText(path, Encoding.UTF8));
            }
            catch { return string.Empty; }
        }

'''
    dynamic_pattern = r"        private async Task<bool> IsPrinterProReadyOnceAsync\(\)\n.*?        private async Task<bool> WaitForPrinterProAsync"
    # Do not hand C# backslashes to re.sub as a replacement template: it would
    # turn the required C# `\\s` regex escape into an invalid `\s` literal.
    text, replaced = re.subn(
        dynamic_pattern,
        lambda _match: dynamic_ready + "        private async Task<bool> WaitForPrinterProAsync",
        text,
        count=1,
        flags=re.S,
    )
    if replaced != 1:
        raise RuntimeError(f"dynamic Yazici readiness replacement expected one occurrence, found {replaced}")
    return ("\ufeff" + text).encode("utf-8")
