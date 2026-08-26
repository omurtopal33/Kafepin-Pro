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
        "        private readonly TabPage printerPanelTab;\n"
        "        private readonly TabPage edevletTab;\n",
        "e-Devlet controls",
    )
    text = _replace(
        text,
        "        private bool printerBrowserReady;\n",
        "        private bool printerBrowserReady;\n"
        "        private bool edevletBrowserReady;\n"
        "        private Task<CoreWebView2Environment> edevletEnvironmentTask;\n",
        "e-Devlet state",
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
        "            edevletBrowser = new WebView2();\n"
        "            edevletBrowser.Dock = DockStyle.Fill;\n"
        "            edevletBrowser.Visible = false;\n"
        "            edevletTab.Controls.Add(edevletBrowser);\n"
        "            FlowLayoutPanel edevletToolbar = new FlowLayoutPanel();\n"
        "            edevletToolbar.Dock = DockStyle.Top; edevletToolbar.Height = 44; edevletToolbar.WrapContents = false; edevletToolbar.Padding = new Padding(6, 5, 6, 4);\n"
        "            Button edevletHome = new Button(); edevletHome.Text = \"e-Devlet Ana\"; edevletHome.Width = 105; edevletHome.Height = 32;\n"
        "            Button ikamet = new Button(); ikamet.Text = \"İkametgâh\"; ikamet.Width = 105; ikamet.Height = 32;\n"
        "            Button adli = new Button(); adli.Text = \"Adli Sicil\"; adli.Width = 105; adli.Height = 32;\n"
        "            Button sgk = new Button(); sgk.Text = \"SGK Dökümü\"; sgk.Width = 112; sgk.Height = 32;\n"
        "            Button endSession = new Button(); endSession.Text = \"Oturumu Bitir\"; endSession.Width = 118; endSession.Height = 32;\n"
        "            edevletHome.Click += async delegate { await OpenEdevletUrlAsync(EdevletHomeUrl); };\n"
        "            ikamet.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/nvi-yerlesim-yeri-ve-diger-adres-belgesi-sorgulama\"); };\n"
        "            adli.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/adli-sicil-kaydi\"); };\n"
        "            sgk.Click += async delegate { await OpenEdevletUrlAsync(\"https://www.turkiye.gov.tr/sgk-tescil-ve-hizmet-dokumu\"); };\n"
        "            endSession.Click += async delegate { await ClearEdevletSessionAsync(); };\n"
        "            edevletToolbar.Controls.Add(edevletHome); edevletToolbar.Controls.Add(ikamet); edevletToolbar.Controls.Add(adli); edevletToolbar.Controls.Add(sgk); edevletToolbar.Controls.Add(endSession);\n"
        "            edevletTab.Controls.Add(edevletToolbar); edevletToolbar.BringToFront();\n"
        "            printerTabs.TabPages.Add(printerPanelTab);\n"
        "            printerTabs.TabPages.Add(edevletTab);\n"
        "            printerTabs.SelectedIndexChanged += async delegate { if (printerTabs.SelectedTab == edevletTab) { try { await EnsureEdevletBrowserAsync(); } catch (Exception ex) { MessageBox.Show(\"e-Devlet açılamadı:\\n\" + ex.Message, \"KafePin e-Devlet\", MessageBoxButtons.OK, MessageBoxIcon.Error); } } };\n"
        "            contentPanel.Controls.Add(printerTabs);\n",
        "printer tabs construction",
    )
    text = _replace(
        text,
        "try { printerBrowser.Dispose(); } catch { }",
        "try { printerBrowser.Dispose(); } catch { } try { edevletBrowser.Dispose(); } catch { }",
        "e-Devlet dispose",
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
            printerTabs.Visible = true;
            printerTabs.BringToFront();
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
                if (IsEdevletUrl(e.Uri)) return;
                e.Cancel = true;
            };
            edevletBrowser.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                edevletBrowserReady = e.IsSuccess;
                if (e.IsSuccess) UpdateNavButtons(edevletBrowser.Source == null ? EdevletHomeUrl : edevletBrowser.Source.ToString());
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

        private async Task ClearEdevletSessionAsync()
        {
            if (edevletBrowser.CoreWebView2 == null) return;
            try { await edevletBrowser.CoreWebView2.ExecuteScriptAsync("try{localStorage.clear();sessionStorage.clear();}catch(e){}"); } catch { }
            try { edevletBrowser.CoreWebView2.CookieManager.DeleteAllCookies(); } catch { }
            try { await edevletBrowser.CoreWebView2.CallDevToolsProtocolMethodAsync("Network.clearBrowserCache", "{}"); } catch { }
            try { await edevletBrowser.CoreWebView2.CallDevToolsProtocolMethodAsync("Network.clearBrowserCookies", "{}"); } catch { }
            try { edevletBrowser.Source = new Uri("about:blank"); } catch { }
            edevletBrowserReady = false;
        }

'''
    text = _replace(text, anchor, methods + anchor, "e-Devlet methods")
    text = _replace(
        text,
        "                    printerBrowser.Visible = true;\n                    printerBrowser.BringToFront();\n                    if (whatsAppViewActive && whatsAppPanel.Visible)\n                        whatsAppPanel.BringToFront();\n                    UpdateNavButtons(PrinterProUrl);\n",
        "                    printerTabs.Visible = true;\n                    printerTabs.BringToFront();\n                    if (whatsAppViewActive && whatsAppPanel.Visible)\n                        whatsAppPanel.BringToFront();\n                    UpdateNavButtons(PrinterProUrl);\n",
        "printer navigation completion",
    )
    text = _replace(
        text,
        "            if (IsPrinterProUrl(e.Uri))\n            {\n                printerBrowser.CoreWebView2.Navigate(e.Uri);\n                return;\n            }\n            OpenExternal(e.Uri);\n",
        "            if (IsPrinterProUrl(e.Uri))\n            {\n                printerBrowser.CoreWebView2.Navigate(e.Uri);\n                return;\n            }\n            return;\n",
        "printer popup isolation",
    )
    text = text.replace("            printerBrowser.Visible = false;\n", "            printerBrowser.Visible = false;\n            printerTabs.Visible = false;\n")

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
