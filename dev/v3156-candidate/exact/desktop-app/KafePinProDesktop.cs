using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// KAFEPIN_MP3_BOT_INTEGRATION: v2.32.1-persistent-shared-environment-fix — dual WebView2; shared CoreWebView2Environment
namespace KafePinProDesktop
{
    internal static class NativeMethods
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
        [DllImport("user32.dll")]
        internal static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        internal static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\KafePinProDesktopApp", out createdNew))
            {
                if (!createdNew)
                {
                    IntPtr hwnd = NativeMethods.FindWindow(null, "KafePin Pro");
                    if (hwnd != IntPtr.Zero)
                    {
                        NativeMethods.ShowWindowAsync(hwnd, 9);
                        NativeMethods.SetForegroundWindow(hwnd);
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // WebView2 loader location is a process-wide setting. It MUST be
                // configured exactly once, before any CoreWebView2Environment API.
                CoreWebView2Environment.SetLoaderDllFolderPath(AppDomain.CurrentDomain.BaseDirectory);

                Application.Run(new MainForm());
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private const string HomeUrl = "http://127.0.0.1:3000/kafepin-pro-yonetim.html";
        private const string AdminUrl = "http://127.0.0.1:3000/admin.html";
        private const string MonitorUrl = "http://127.0.0.1:3000/monitor.html";
        private const string EveryCafeSyncUrl = "http://127.0.0.1:3000/everycafe-sync.html";
        private const string EveryCafeHistoryUrl = "http://127.0.0.1:3000/everycafe-history.html";
        private const string EveryCafeIntegrationUrl = "http://127.0.0.1:3000/everycafe-integration.html";
        private const string Mp3BotUrl = "http://127.0.0.1:17890/";
        private const string Mp3BotRoot = @"C:\KafePinMp3BotPRO";
        private const string PrinterProUrl = "http://127.0.0.1:17891/";
        private const string WhatsAppUrl = "https://web.whatsapp.com/";
        private const string ServiceProUrl = "http://127.0.0.1:17892/";
        private const string ServiceProRoot = @"C:\KafePinTeknikServisPRO";
        // Paketle birlikte gelen bağımsız servis. KafePin sunucusu/DB/session
        // katmanına erişmez; yalnız kendi loopback portunda çalışır.
        private const string PrinterProRoot = @"C:\KafePin\KafePinYaziciPRO";

        private readonly WebView2 browser;
        private readonly WebView2 mp3Browser;
        private readonly WebView2 printerBrowser;
        private readonly WebView2 whatsAppBrowser;
        private readonly WebView2 serviceBrowser;
        private readonly Panel contentPanel;
        private readonly Panel splash;
        private readonly Label splashTitle;
        private readonly Label splashText;
        private readonly Button retryButton;
        private readonly Button managementButton;
        private readonly Button adminButton;
        private readonly Button monitorButton;
        private readonly Button everyCafeSyncButton;
        private readonly Button everyCafeHistoryButton;
        private readonly Button everyCafeIntegrationButton;
        private readonly Button mp3BotButton;
        private readonly Button printerProButton;
        private readonly Button serviceProButton;
        private readonly Button refreshButton;
        private readonly System.Windows.Forms.Timer serverWatchTimer;
        private bool initializing;
        private bool hasLoadedOnce;
        private bool serverWatchBusy;
        private bool serverWasUnavailable;
        private DateTime? serverUnavailableSince;
        private bool automaticRecoveryAttempted;
        private bool automaticRecoveryBusy;
        private bool mp3BrowserInitializing;
        private bool mp3BrowserReady;
        private bool mp3ViewActive;
        private bool printerBrowserInitializing;
        private bool printerBrowserReady;
        private bool printerViewActive;
        private bool whatsAppBrowserReady;
        private bool whatsAppViewActive;
        private bool serviceBrowserReady;
        private bool serviceViewActive;
        private CoreWebView2Environment sharedWebViewEnvironment;
        private Task<CoreWebView2Environment> sharedWebViewEnvironmentTask;
        private string lastServerVersion = string.Empty;
        private string targetUrl = HomeUrl;
        private readonly string maintenanceLockPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "KafePinPro", "maintenance.lock");

        internal MainForm()
        {
            Text = "KafePin Pro";
            StartPosition = FormStartPosition.CenterScreen;
            WindowState = FormWindowState.Maximized;
            MinimumSize = new Size(960, 650);
            BackColor = Color.FromArgb(9, 13, 20);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            Panel topBar = new Panel();
            topBar.Dock = DockStyle.Top;
            topBar.Height = 56;
            topBar.BackColor = Color.FromArgb(12, 23, 34);
            topBar.Padding = new Padding(12, 8, 12, 8);

            Label brand = new Label();
            brand.Text = "KafePin Pro";
            brand.ForeColor = Color.FromArgb(105, 236, 183);
            brand.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
            brand.AutoSize = false;
            brand.TextAlign = ContentAlignment.MiddleLeft;
            brand.SetBounds(12, 8, 150, 40);
            topBar.Controls.Add(brand);

            managementButton = MakeNavButton("Yönetim", 160, 12, 100);
            adminButton = MakeNavButton("Admin", 268, 12, 70);
            monitorButton = MakeNavButton("Monitör", 346, 12, 76);
            everyCafeSyncButton = MakeNavButton("EveryCafe Senkron", 430, 12, 124);
            everyCafeHistoryButton = MakeNavButton("Geçmiş Aktarım", 562, 12, 120);
            everyCafeIntegrationButton = MakeNavButton("Entegrasyon Günlüğü", 690, 12, 136);
            mp3BotButton = MakeNavButton("🎵 MP3 Bot PRO", 834, 12, 132);
            printerProButton = MakeNavButton("🖨️ Yazıcı PRO", 974, 12, 128);
            serviceProButton = MakeNavButton("🛠 Teknik Servis PRO", 1110, 12, 150);
            refreshButton = MakeNavButton("Yenile", 1268, 12, 70);

            managementButton.Click += delegate { NavigateLocal(HomeUrl); };
            adminButton.Click += delegate { NavigateLocal(AdminUrl); };
            monitorButton.Click += delegate { NavigateLocal(MonitorUrl); };
            everyCafeSyncButton.Click += delegate { NavigateLocal(EveryCafeSyncUrl); };
            everyCafeHistoryButton.Click += delegate { NavigateLocal(EveryCafeHistoryUrl); };
            everyCafeIntegrationButton.Click += delegate { NavigateLocal(EveryCafeIntegrationUrl); };
            mp3BotButton.Click += Mp3BotButton_Click;
            printerProButton.Click += PrinterProButton_Click;
            serviceProButton.Click += ServiceProButton_Click;
            refreshButton.Click += async delegate
            {
                try
                {
                    if (mp3ViewActive && mp3Browser.CoreWebView2 != null)
                    {
                        // Yenile güncel MP3 panel dosyalarını anında alır. Önce
                        // çalan parça/konum saklanır, yeni panel geri yükler.
                        await mp3Browser.CoreWebView2.ExecuteScriptAsync(
                            "window.kafePinPrepareReload ? window.kafePinPrepareReload() : false;"
                        );
                        mp3Browser.CoreWebView2.Reload();
                        return;
                    }
                    if (whatsAppViewActive && whatsAppBrowser.CoreWebView2 != null)
                    {
                        whatsAppBrowser.CoreWebView2.Reload();
                        return;
                    }
                    if (printerViewActive && printerBrowser.CoreWebView2 != null)
                    {
                        printerBrowser.CoreWebView2.Reload();
                        return;
                    }
                    if (serviceViewActive && serviceBrowser.CoreWebView2 != null)
                    {
                        serviceBrowser.CoreWebView2.Reload();
                        return;
                    }
                    NavigateLocal(targetUrl);
                }
                catch { }
            };

            topBar.Controls.Add(managementButton);
            topBar.Controls.Add(adminButton);
            topBar.Controls.Add(monitorButton);
            topBar.Controls.Add(everyCafeSyncButton);
            topBar.Controls.Add(everyCafeHistoryButton);
            topBar.Controls.Add(everyCafeIntegrationButton);
            topBar.Controls.Add(mp3BotButton);
            topBar.Controls.Add(printerProButton);
            topBar.Controls.Add(serviceProButton);
            topBar.Controls.Add(refreshButton);

            Label hint = new Label();
            hint.Text = "Masaüstü uygulaması";
            hint.ForeColor = Color.FromArgb(130, 155, 176);
            hint.Font = new Font("Segoe UI", 9F, FontStyle.Regular);
            hint.AutoSize = false;
            hint.TextAlign = ContentAlignment.MiddleRight;
            hint.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            hint.SetBounds(Math.Max(1052, ClientSize.Width - 138), 8, 128, 40);
            topBar.Controls.Add(hint);
            topBar.Resize += delegate { hint.Visible = topBar.ClientSize.Width >= 1220; hint.Left = Math.Max(1052, topBar.ClientSize.Width - 138); };

            contentPanel = new Panel();
            contentPanel.Dock = DockStyle.Fill;
            contentPanel.BackColor = Color.FromArgb(9, 13, 20);

            browser = new WebView2();
            browser.Dock = DockStyle.Fill;
            browser.Visible = false;
            contentPanel.Controls.Add(browser);

            // MP3 uses its own WebView2 control. It is never navigated away when
            // the user returns to KafePin pages; it stays alive behind the main
            // browser so Web Audio playback continues without interruption.
            mp3Browser = new WebView2();
            mp3Browser.Dock = DockStyle.Fill;
            mp3Browser.Visible = false;
            contentPanel.Controls.Add(mp3Browser);

            printerBrowser = new WebView2();
            printerBrowser.Dock = DockStyle.Fill;
            printerBrowser.Visible = false;
            contentPanel.Controls.Add(printerBrowser);

            whatsAppBrowser = new WebView2();
            whatsAppBrowser.Dock = DockStyle.Fill;
            whatsAppBrowser.Visible = false;
            contentPanel.Controls.Add(whatsAppBrowser);

            serviceBrowser = new WebView2();
            serviceBrowser.Dock = DockStyle.Fill;
            serviceBrowser.Visible = false;
            contentPanel.Controls.Add(serviceBrowser);

            splash = new Panel();
            splash.Dock = DockStyle.Fill;
            splash.BackColor = Color.FromArgb(9, 13, 20);
            contentPanel.Controls.Add(splash);
            splash.BringToFront();

            splashTitle = new Label();
            splashTitle.AutoSize = false;
            splashTitle.TextAlign = ContentAlignment.MiddleCenter;
            splashTitle.ForeColor = Color.FromArgb(98, 240, 179);
            splashTitle.Font = new Font("Segoe UI", 28F, FontStyle.Bold);
            splashTitle.Text = "KafePin Pro";
            splashTitle.Height = 60;
            splash.Controls.Add(splashTitle);

            splashText = new Label();
            splashText.AutoSize = false;
            splashText.TextAlign = ContentAlignment.MiddleCenter;
            splashText.ForeColor = Color.FromArgb(190, 214, 232);
            splashText.Font = new Font("Segoe UI", 12F, FontStyle.Regular);
            splashText.Text = "Yönetim Merkezi başlatılıyor...";
            splashText.Height = 36;
            splash.Controls.Add(splashText);

            retryButton = new Button();
            retryButton.Text = "Yeniden Dene";
            retryButton.Width = 150;
            retryButton.Height = 38;
            retryButton.Visible = false;
            retryButton.FlatStyle = FlatStyle.Flat;
            retryButton.ForeColor = Color.White;
            retryButton.BackColor = Color.FromArgb(22, 69, 47);
            retryButton.FlatAppearance.BorderColor = Color.FromArgb(39, 138, 91);
            retryButton.Click += RetryButton_Click;
            splash.Controls.Add(retryButton);

            Controls.Add(contentPanel);
            Controls.Add(topBar);

            serverWatchTimer = new System.Windows.Forms.Timer();
            serverWatchTimer.Interval = 1500;
            serverWatchTimer.Tick += ServerWatchTimer_Tick;

            contentPanel.Resize += delegate { LayoutSplash(); };
            Shown += delegate { BeginInitialize(); serverWatchTimer.Start(); };
            FormClosing += delegate { try { serverWatchTimer.Stop(); } catch { } try { browser.Dispose(); } catch { } try { mp3Browser.Dispose(); } catch { } try { printerBrowser.Dispose(); } catch { } };
            LayoutSplash();
            UpdateNavButtons(HomeUrl);
        }

        private Button MakeNavButton(string text, int left, int top, int width)
        {
            Button b = new Button();
            b.Text = text;
            b.SetBounds(left, top, width, 34);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 1;
            b.FlatAppearance.BorderColor = Color.FromArgb(55, 82, 103);
            b.BackColor = Color.FromArgb(24, 42, 58);
            b.ForeColor = Color.FromArgb(228, 239, 248);
            b.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            b.Cursor = Cursors.Hand;
            return b;
        }

        private void SetActive(Button button, bool active)
        {
            button.BackColor = active ? Color.FromArgb(29, 111, 78) : Color.FromArgb(24, 42, 58);
            button.FlatAppearance.BorderColor = active ? Color.FromArgb(70, 200, 143) : Color.FromArgb(55, 82, 103);
            button.ForeColor = active ? Color.White : Color.FromArgb(228, 239, 248);
        }

        private void UpdateNavButtons(string url)
        {
            string value = (url ?? "").ToLowerInvariant();
            SetActive(managementButton, value.Contains("kafepin-pro-yonetim"));
            SetActive(adminButton, value.EndsWith("/admin.html") || value.Contains("/admin.html?"));
            SetActive(monitorButton, value.EndsWith("/monitor.html") || value.Contains("/monitor.html?"));
            SetActive(everyCafeSyncButton, value.EndsWith("/everycafe-sync.html") || value.Contains("/everycafe-sync.html?"));
            SetActive(everyCafeHistoryButton, value.EndsWith("/everycafe-history.html") || value.Contains("/everycafe-history.html?"));
            SetActive(everyCafeIntegrationButton, !mp3ViewActive && !printerViewActive && !whatsAppViewActive && !serviceViewActive && (value.EndsWith("/everycafe-integration.html") || value.Contains("/everycafe-integration.html?")));
            SetActive(mp3BotButton, mp3ViewActive || value.StartsWith("http://127.0.0.1:17890") || value.StartsWith("http://localhost:17890"));
            SetActive(printerProButton, printerViewActive || whatsAppViewActive || value.StartsWith("http://127.0.0.1:17891") || value.StartsWith("http://localhost:17891") || value.StartsWith("https://web.whatsapp.com"));
            SetActive(serviceProButton, serviceViewActive || value.StartsWith("http://127.0.0.1:17892") || value.StartsWith("http://localhost:17892"));
            if (mp3ViewActive || printerViewActive || whatsAppViewActive || serviceViewActive)
            {
                SetActive(managementButton, false);
                SetActive(adminButton, false);
                SetActive(monitorButton, false);
                SetActive(everyCafeSyncButton, false);
                SetActive(everyCafeHistoryButton, false);
                SetActive(everyCafeIntegrationButton, false);
            }
        }

        private async void Mp3BotButton_Click(object sender, EventArgs e)
        {
            try
            {
                mp3BotButton.Enabled = false;
                mp3BotButton.Text = "🎵 MP3 Açılıyor...";

                if (!await IsMp3BotReadyOnceAsync())
                {
                    string launcher = Path.Combine(Mp3BotRoot, "START_WEB.ps1");
                    if (!File.Exists(launcher))
                    {
                        MessageBox.Show(
                            "KafePin MP3 Bot PRO kurulu değil.\n\nBeklenen klasör:\n" + Mp3BotRoot,
                            "KafePin MP3 Bot PRO",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                        return;
                    }

                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "powershell.exe";
                    psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + launcher + "\"";
                    psi.WorkingDirectory = Mp3BotRoot;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);

                    if (!await WaitForMp3BotAsync(30))
                    {
                        MessageBox.Show(
                            "MP3 Bot servisi 30 saniyede hazır olmadı.\n\nC:\\KafePinMp3BotPRO\\logs klasörünü kontrol edin.",
                            "KafePin MP3 Bot PRO",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error);
                        return;
                    }
                }

                await EnsureMp3BrowserAsync();
                ShowMp3View();
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "MP3 Bot açılamadı:\n" + ex.Message,
                    "KafePin MP3 Bot PRO",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            finally
            {
                mp3BotButton.Text = "🎵 MP3 Bot PRO";
                mp3BotButton.Enabled = true;
            }
        }

        private async void PrinterProButton_Click(object sender, EventArgs e)
        {
            try
            {
                printerProButton.Enabled = false;
                printerProButton.Text = "🖨️ Yazıcı Açılıyor...";
                if (!await IsPrinterProReadyOnceAsync())
                {
                    string starter = Path.Combine(PrinterProRoot, "START_YAZICI_PRO.cmd");
                    if (!File.Exists(starter))
                        throw new InvalidOperationException("Yazıcı PRO başlatıcısı bulunamadı: " + starter);
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "cmd.exe";
                    psi.Arguments = "/c \"\"" + starter + "\" --service-only\"";
                    psi.WorkingDirectory = PrinterProRoot;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    using (Process p = Process.Start(psi))
                    {
                        if (p != null) await Task.Run(delegate { try { p.WaitForExit(30000); } catch { } });
                    }
                    if (!await WaitForPrinterProAsync(25))
                        throw new InvalidOperationException("Yazıcı PRO servisleri hazır olmadı. 17891 ve gelir servisi birlikte başlatılamadı.");
                }
                await EnsurePrinterBrowserAsync();
                ShowPrinterView();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Yazıcı PRO açılamadı:\n" + ex.Message, "KafePin Yazıcı PRO", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                printerProButton.Text = "🖨️ Yazıcı PRO";
                printerProButton.Enabled = true;
            }
        }

        private async void ServiceProButton_Click(object sender, EventArgs e)
        {
            try
            {
                serviceProButton.Enabled = false;
                serviceProButton.Text = "🛠 Servis Açılıyor...";
                if (!await IsServiceProReadyAsync())
                {
                    string service = Path.Combine(ServiceProRoot, "web_service.py");
                    if (!File.Exists(service)) throw new InvalidOperationException("Teknik Servis PRO dosyaları bulunamadı: " + ServiceProRoot);
                    ProcessStartInfo psi = new ProcessStartInfo("py.exe", "-3 -B \"" + service + "\"");
                    psi.WorkingDirectory = ServiceProRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                    for (int i = 0; i < 40 && !await IsServiceProReadyAsync(); i++) await Task.Delay(500);
                    if (!await IsServiceProReadyAsync()) throw new InvalidOperationException("Teknik Servis PRO servisi başlatılamadı.");
                }
                await EnsureServiceBrowserAsync(); ShowServiceView();
            }
            catch (Exception ex) { MessageBox.Show("Teknik Servis PRO açılamadı:\n" + ex.Message, "Teknik Servis PRO", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { serviceProButton.Text = "🛠 Teknik Servis PRO"; serviceProButton.Enabled = true; }
        }

        private async Task<bool> EnsurePrinterRuntimeAsync()
        {
            return await Task.Run(delegate
            {
                try
                {
                    string installer = Path.Combine(PrinterProRoot, "KURULUM.cmd");
                    if (!File.Exists(installer)) return false;
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "cmd.exe";
                    psi.Arguments = "/c \"\"" + installer + "\" /silent\"";
                    psi.WorkingDirectory = PrinterProRoot;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    using (Process setup = Process.Start(psi))
                    {
                        if (setup == null || !setup.WaitForExit(120000) || setup.ExitCode != 0) return false;
                    }
                    return File.Exists(Path.Combine(PrinterProRoot, ".venv", "Scripts", "pythonw.exe"));
                }
                catch { return false; }
            });
        }

        private Task<CoreWebView2Environment> GetSharedWebViewEnvironmentAsync()
        {
            if (sharedWebViewEnvironment != null)
                return Task.FromResult(sharedWebViewEnvironment);

            if (sharedWebViewEnvironmentTask == null)
                sharedWebViewEnvironmentTask = CreateSharedWebViewEnvironmentAsync();

            return sharedWebViewEnvironmentTask;
        }

        private async Task<CoreWebView2Environment> CreateSharedWebViewEnvironmentAsync()
        {
            string userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "KafePinPro", "WebView2");
            Directory.CreateDirectory(userData);

            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
            sharedWebViewEnvironment = env;
            return env;
        }

        private async Task EnsureMp3BrowserAsync()
        {
            if (mp3BrowserReady && mp3Browser.CoreWebView2 != null) return;
            if (mp3BrowserInitializing)
            {
                int guard = 0;
                while (mp3BrowserInitializing && guard++ < 100)
                    await Task.Delay(100);
                if (mp3BrowserReady && mp3Browser.CoreWebView2 != null) return;
            }

            mp3BrowserInitializing = true;
            try
            {
                // Reuse the SAME environment as the main KafePin WebView.
                // Calling SetLoaderDllFolderPath a second time after CreateAsync
                // causes the WebView2 runtime exception seen in v2.32.
                CoreWebView2Environment env = await GetSharedWebViewEnvironmentAsync();
                await mp3Browser.EnsureCoreWebView2Async(env);

                mp3Browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                mp3Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                mp3Browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
                mp3Browser.CoreWebView2.Settings.IsZoomControlEnabled = false;
                mp3Browser.CoreWebView2.NewWindowRequested += Mp3CoreWebView2_NewWindowRequested;
                mp3Browser.CoreWebView2.NavigationStarting += Mp3CoreWebView2_NavigationStarting;
                mp3Browser.NavigationCompleted += Mp3Browser_NavigationCompleted;
                mp3Browser.CoreWebView2.ProcessFailed += delegate
                {
                    mp3BrowserReady = false;
                };

                mp3Browser.Source = new Uri(WithCacheBust(Mp3BotUrl));
                int wait = 0;
                while (!mp3BrowserReady && wait++ < 150)
                    await Task.Delay(100);
                if (!mp3BrowserReady)
                    throw new InvalidOperationException("MP3 paneli WebView2 içinde yüklenemedi.");
            }
            finally
            {
                mp3BrowserInitializing = false;
            }
        }

        private void ShowMp3View()
        {
            mp3ViewActive = true;
            printerViewActive = false;
            whatsAppViewActive = false;
            serviceViewActive = false;
            splash.Visible = false;
            browser.Visible = false;
            printerBrowser.Visible = false;
            whatsAppBrowser.Visible = false;
            serviceBrowser.Visible = false;
            mp3Browser.Visible = true;
            mp3Browser.BringToFront();
            UpdateNavButtons(Mp3BotUrl);
        }

        private void Mp3Browser_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                mp3BrowserReady = true;
                if (mp3ViewActive)
                {
                    splash.Visible = false;
                    mp3Browser.Visible = true;
                    mp3Browser.BringToFront();
                    UpdateNavButtons(Mp3BotUrl);
                }
            }
            else
            {
                mp3BrowserReady = false;
            }
        }

        private void Mp3CoreWebView2_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsMp3BotUrl(e.Uri)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        }

        private void Mp3CoreWebView2_NewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (IsMp3BotUrl(e.Uri))
            {
                mp3Browser.CoreWebView2.Navigate(e.Uri);
                return;
            }
            OpenExternal(e.Uri);
        }

        private async Task<bool> IsMp3BotReadyOnceAsync()
        {
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Mp3BotUrl + "api/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    req.Method = "GET";
                    req.Timeout = 900;
                    req.ReadWriteTimeout = 900;
                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        bool statusOk = (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300;
                        string isolation = resp.Headers["X-KafePin-MP3-Isolation"] ?? string.Empty;
                        return statusOk && string.Equals(isolation, "separate-loopback-service", StringComparison.OrdinalIgnoreCase);
                    }
                }
                catch { return false; }
            });
        }

        private async Task<bool> WaitForMp3BotAsync(int maxSeconds)
        {
            int attempts = Math.Max(1, maxSeconds * 2);
            for (int i = 0; i < attempts; i++)
            {
                if (await IsMp3BotReadyOnceAsync()) return true;
                await Task.Delay(500);
            }
            return false;
        }

        private async Task<bool> IsServiceProReadyAsync()
        {
            return await Task.Run(delegate { try { HttpWebRequest req=(HttpWebRequest)WebRequest.Create(ServiceProUrl+"api/health");req.Timeout=900;using(HttpWebResponse r=(HttpWebResponse)req.GetResponse()){return (int)r.StatusCode==200;}} catch{return false;} });
        }

        private async Task EnsureServiceBrowserAsync()
        {
            if (serviceBrowserReady && serviceBrowser.CoreWebView2 != null) return;
            CoreWebView2Environment env=await GetSharedWebViewEnvironmentAsync();
            await serviceBrowser.EnsureCoreWebView2Async(env);
            serviceBrowser.CoreWebView2.Settings.AreDevToolsEnabled=false;
            serviceBrowser.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
            serviceBrowser.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e){ if(!IsServiceProUrl(e.Uri)){e.Cancel=true;OpenExternal(e.Uri);} };
            serviceBrowser.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e){serviceBrowserReady=e.IsSuccess;};
            serviceBrowser.Source=new Uri(WithCacheBust(ServiceProUrl));
            for(int i=0;i<100&&!serviceBrowserReady;i++) await Task.Delay(100);
            if(!serviceBrowserReady) throw new InvalidOperationException("Teknik Servis PRO paneli WebView2 içinde yüklenemedi.");
        }

        private void ShowServiceView()
        {
            mp3ViewActive=false; printerViewActive=false; whatsAppViewActive=false; serviceViewActive=true; splash.Visible=false; browser.Visible=false; mp3Browser.Visible=false; printerBrowser.Visible=false; whatsAppBrowser.Visible=false; serviceBrowser.Visible=true; serviceBrowser.BringToFront(); UpdateNavButtons(ServiceProUrl);
        }

        private static bool IsServiceProUrl(string value)
        {
            Uri uri; if(!Uri.TryCreate(value,UriKind.Absolute,out uri))return false; return (uri.Scheme=="http"||uri.Scheme=="https") && (string.Equals(uri.Host,"127.0.0.1",StringComparison.OrdinalIgnoreCase)||string.Equals(uri.Host,"localhost",StringComparison.OrdinalIgnoreCase)) && uri.Port==17892;
        }

        private async Task EnsurePrinterBrowserAsync()
        {
            if (printerBrowserReady && printerBrowser.CoreWebView2 != null) return;
            if (printerBrowserInitializing)
            {
                int guard = 0;
                while (printerBrowserInitializing && guard++ < 100) await Task.Delay(100);
                if (printerBrowserReady && printerBrowser.CoreWebView2 != null) return;
            }
            printerBrowserInitializing = true;
            try
            {
                CoreWebView2Environment env = await GetSharedWebViewEnvironmentAsync();
                await printerBrowser.EnsureCoreWebView2Async(env);
                printerBrowser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                printerBrowser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                printerBrowser.CoreWebView2.Settings.IsStatusBarEnabled = false;
                printerBrowser.CoreWebView2.Settings.IsZoomControlEnabled = false;
                printerBrowser.CoreWebView2.Settings.IsWebMessageEnabled = true;
                printerBrowser.CoreWebView2.NewWindowRequested += PrinterCoreWebView2_NewWindowRequested;
                printerBrowser.CoreWebView2.NavigationStarting += PrinterCoreWebView2_NavigationStarting;
                printerBrowser.CoreWebView2.WebMessageReceived += PrinterCoreWebView2_WebMessageReceived;
                printerBrowser.NavigationCompleted += PrinterBrowser_NavigationCompleted;
                printerBrowser.CoreWebView2.ProcessFailed += delegate { printerBrowserReady = false; };
                printerBrowser.Source = new Uri(WithCacheBust(PrinterProUrl));
                int wait = 0;
                while (!printerBrowserReady && wait++ < 150) await Task.Delay(100);
                if (!printerBrowserReady) throw new InvalidOperationException("Yazıcı PRO paneli WebView2 içinde yüklenemedi.");
            }
            finally { printerBrowserInitializing = false; }
        }

        private void ShowPrinterView()
        {
            mp3ViewActive = false;
            printerViewActive = true;
            whatsAppViewActive = false;
            serviceViewActive = false;
            splash.Visible = false;
            browser.Visible = false;
            mp3Browser.Visible = false;
            whatsAppBrowser.Visible = false;
            serviceBrowser.Visible = false;
            printerBrowser.Visible = true;
            printerBrowser.BringToFront();
            UpdateNavButtons(PrinterProUrl);
        }



        private async void PrinterCoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                string message = e.TryGetWebMessageAsString();
                if (!string.Equals(message, "open-whatsapp", StringComparison.Ordinal)) return;
                await EnsureWhatsAppBrowserAsync();
                ShowWhatsAppView();
            }
            catch (Exception ex)
            {
                MessageBox.Show("WhatsApp Web açılamadı:\n" + ex.Message, "KafePin Yazıcı PRO", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task EnsureWhatsAppBrowserAsync()
        {
            if (whatsAppBrowserReady && whatsAppBrowser.CoreWebView2 != null) return;
            CoreWebView2Environment env = await GetSharedWebViewEnvironmentAsync();
            await whatsAppBrowser.EnsureCoreWebView2Async(env);
            whatsAppBrowser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            whatsAppBrowser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            whatsAppBrowser.CoreWebView2.Settings.IsZoomControlEnabled = true;
            whatsAppBrowser.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try { if (!string.IsNullOrWhiteSpace(e.Uri)) whatsAppBrowser.CoreWebView2.Navigate(e.Uri); } catch { }
            };
            whatsAppBrowser.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e) { whatsAppBrowserReady = e.IsSuccess; };
            whatsAppBrowser.CoreWebView2.ProcessFailed += delegate { whatsAppBrowserReady = false; };
            whatsAppBrowser.Source = new Uri(WhatsAppUrl);
            for (int i=0; i<200 && !whatsAppBrowserReady; i++) await Task.Delay(100);
            if (!whatsAppBrowserReady) throw new InvalidOperationException("WhatsApp Web, KafePin içindeki WebView2'de yüklenemedi.");
        }

        private void ShowWhatsAppView()
        {
            mp3ViewActive = false; printerViewActive = false; whatsAppViewActive = true; serviceViewActive = false;
            splash.Visible = false; browser.Visible = false; mp3Browser.Visible = false; printerBrowser.Visible = false; serviceBrowser.Visible = false;
            whatsAppBrowser.Visible = true; whatsAppBrowser.BringToFront(); UpdateNavButtons(WhatsAppUrl);
        }

        private void PrinterBrowser_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                printerBrowserReady = true;
                if (printerViewActive)
                {
                    splash.Visible = false;
                    printerBrowser.Visible = true;
                    printerBrowser.BringToFront();
                    UpdateNavButtons(PrinterProUrl);
                }
            }
            else printerBrowserReady = false;
        }

        private void PrinterCoreWebView2_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsPrinterProUrl(e.Uri)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        }

        private void PrinterCoreWebView2_NewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (IsPrinterProUrl(e.Uri))
            {
                printerBrowser.CoreWebView2.Navigate(e.Uri);
                return;
            }
            OpenExternal(e.Uri);
        }

        private async Task<bool> IsPrinterProReadyOnceAsync()
        {
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PrinterProUrl + "api/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    req.Method = "GET"; req.Timeout = 1200; req.ReadWriteTimeout = 1200;
                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return false;
                        string isolation = resp.Headers["X-KafePin-Yazici-Isolation"] ?? string.Empty;
                        if (!string.Equals(isolation, "separate-loopback-service", StringComparison.OrdinalIgnoreCase)) return false;
                    }
                    HttpWebRequest rev = (HttpWebRequest)WebRequest.Create(PrinterProUrl + "revenue/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    rev.Method = "GET"; rev.Timeout = 1200; rev.ReadWriteTimeout = 1200;
                    using (HttpWebResponse resp = (HttpWebResponse)rev.GetResponse()) return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300;
                }
                catch { return false; }
            });
        }

        private async Task<bool> WaitForPrinterProAsync(int maxSeconds)
        {
            int attempts = Math.Max(1, maxSeconds * 2);
            for (int i = 0; i < attempts; i++)
            {
                if (await IsPrinterProReadyOnceAsync()) return true;
                await Task.Delay(500);
            }
            return false;
        }

        private string WithCacheBust(string url)
        {
            string clean = string.IsNullOrWhiteSpace(url) ? HomeUrl : url;
            int hashIndex = clean.IndexOf('#');
            string hash = hashIndex >= 0 ? clean.Substring(hashIndex) : string.Empty;
            if (hashIndex >= 0) clean = clean.Substring(0, hashIndex);
            string sep = clean.Contains("?") ? "&" : "?";
            return clean + sep + "_kp=" + DateTime.UtcNow.Ticks.ToString() + hash;
        }

        private void NavigateLocal(string url)
        {
            mp3ViewActive = false;
            printerViewActive = false;
            whatsAppViewActive = false;
            serviceViewActive = false;
            targetUrl = url;
            UpdateNavButtons(url);
            splash.Visible = false;
            mp3Browser.Visible = false;
            printerBrowser.Visible = false;
            whatsAppBrowser.Visible = false;
            serviceBrowser.Visible = false;
            browser.Visible = true;
            browser.BringToFront();
            string freshUrl = WithCacheBust(url);
            try
            {
                if (browser.CoreWebView2 != null)
                {
                    browser.CoreWebView2.Navigate(freshUrl);
                    return;
                }
            }
            catch { }
            BeginInitialize();
        }

        private void LayoutSplash()
        {
            int w = contentPanel.ClientSize.Width;
            int h = contentPanel.ClientSize.Height;
            splashTitle.SetBounds(0, Math.Max(120, h / 2 - 100), w, 60);
            splashText.SetBounds(0, Math.Max(180, h / 2 - 35), w, 36);
            retryButton.Left = Math.Max(10, w / 2 - retryButton.Width / 2);
            retryButton.Top = Math.Max(230, h / 2 + 25);
        }

        private async void BeginInitialize()
        {
            if (initializing) return;
            initializing = true;
            retryButton.Visible = false;
            splash.Visible = true;
            splash.BringToFront();
            splashText.Text = IsMaintenanceActive() ? "KafePin bakım / geri yükleme işlemini tamamlıyor..." : "KafePin sunucusu hazırlanıyor...";

            try
            {
                if (browser.CoreWebView2 == null)
                {
                    CoreWebView2Environment env = await GetSharedWebViewEnvironmentAsync();
                    await browser.EnsureCoreWebView2Async(env);

                    browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    browser.CoreWebView2.Settings.IsZoomControlEnabled = false;

                    browser.CoreWebView2.NewWindowRequested += CoreWebView2_NewWindowRequested;
                    browser.CoreWebView2.NavigationStarting += CoreWebView2_NavigationStarting;
                    browser.CoreWebView2.ProcessFailed += delegate
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            browser.Visible = false;
                            if (!IsEmbeddedToolViewActive())
                            {
                                splash.Visible = true;
                                splash.BringToFront();
                                splashText.Text = "Görüntü motoru yeniden başlatılıyor...";
                                retryButton.Visible = true;
                            }
                        });
                    };
                    browser.NavigationCompleted += Browser_NavigationCompleted;
                }

                if (IsMaintenanceActive()) KickServerManager();
                bool ready = await WaitForServerAsync(IsMaintenanceActive() ? 120 : 45);
                if (!ready)
                {
                    splashText.Text = IsMaintenanceActive() ? "Bakım / geri yükleme beklenenden uzun sürdü. İşlem kilidi devam ediyor." : "KafePin sunucusuna ulaşılamadı. Windows Sistem Yöneticisini kontrol et.";
                    retryButton.Visible = true;
                    initializing = false;
                    return;
                }

                browser.Source = new Uri(WithCacheBust(targetUrl));
            }
            catch (Exception ex)
            {
                splashText.Text = "KafePin Pro açılamadı: " + ex.Message;
                retryButton.Visible = true;
                initializing = false;
            }
        }

        private bool IsMaintenanceActive()
        {
            try
            {
                if (!File.Exists(maintenanceLockPath)) return false;
                DateTime modified = File.GetLastWriteTimeUtc(maintenanceLockPath);
                // Manager 180 sn'de stale lock'u temizler. Desktop 210 sn'den eski
                // kilidi aktif saymaz; böylece Manager yoksa bile onarım düğmesi görünür.
                if ((DateTime.UtcNow - modified).TotalSeconds > 210) return false;
                return true;
            }
            catch { return false; }
        }

        private async void RetryButton_Click(object sender, EventArgs e)
        {
            retryButton.Visible = false;
            retryButton.Text = "Yeniden Dene";
            splashText.Text = "KafePin sunucusu yeniden başlatılıyor...";
            bool recovered = await TryRecoverServerAsync();
            if (recovered)
            {
                serverWasUnavailable = false;
                serverUnavailableSince = null;
                automaticRecoveryAttempted = false;
                targetUrl = HomeUrl;
                NavigateLocal(HomeUrl);
                return;
            }

            splashText.Text = "Sunucu başlatılamadı. 'Sunucuyu Onar' ile tekrar deneyebilirsin.";
            retryButton.Text = "Sunucuyu Onar";
            retryButton.Visible = true;
        }

        private string GetKafePinRoot()
        {
            try
            {
                DirectoryInfo appDir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
                if (appDir.Parent != null) return appDir.Parent.FullName;
            }
            catch { }
            return @"C:\KafePin";
        }

        private void KickServerManager()
        {
            try
            {
                ProcessStartInfo task = new ProcessStartInfo();
                task.FileName = "schtasks.exe";
                task.Arguments = "/Run /TN \"KafePin Pro Server Manager\"";
                task.UseShellExecute = false;
                task.CreateNoWindow = true;
                task.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(task);
            }
            catch { }
        }

        private async Task<bool> TryRecoverServerAsync()
        {
            if (automaticRecoveryBusy) return false;
            automaticRecoveryBusy = true;
            try
            {
                // v1.1.2: Masaustu Node baslatmaz. Once mevcut Server Manager gorevini
                // tetikler. Sunucu gelmezse kullanicinin tikladigi Onar dugmesinde
                // Manager Ensure araci gorevi/config/control-portu yeniden dogrular.
                KickServerManager();
                if (await WaitForServerAsync(12)) return true;

                string ensureScript = Path.Combine(GetKafePinRoot(), "KafePin_Manager_Ensure.ps1");
                if (File.Exists(ensureScript))
                {
                    try
                    {
                        ProcessStartInfo repair = new ProcessStartInfo();
                        repair.FileName = "powershell.exe";
                        repair.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + ensureScript + "\" -InstallRoot \"" + GetKafePinRoot() + "\"";
                        repair.UseShellExecute = true;
                        repair.Verb = "runas";
                        repair.WindowStyle = ProcessWindowStyle.Hidden;
                        Process proc = Process.Start(repair);
                        if (proc != null)
                        {
                            await Task.Run(delegate { try { proc.WaitForExit(30000); } catch { } });
                        }
                    }
                    catch { }
                }

                KickServerManager();
                return await WaitForServerAsync(25);
            }
            finally
            {
                automaticRecoveryBusy = false;
            }
        }

        private async void ServerWatchTimer_Tick(object sender, EventArgs e)
        {
            if (!hasLoadedOnce || serverWatchBusy) return;
            serverWatchBusy = true;
            try
            {
                string version = await GetServerVersionOnceAsync();
                if (version == null)
                {
                    if (!serverWasUnavailable)
                    {
                        serverUnavailableSince = DateTime.UtcNow;
                        automaticRecoveryAttempted = false;
                    }

                    serverWasUnavailable = true;
                    browser.Visible = false;
                    if (!IsEmbeddedToolViewActive())
                    {
                        splash.Visible = true;
                        splash.BringToFront();
                    }

                    TimeSpan unavailableFor = serverUnavailableSince.HasValue
                        ? DateTime.UtcNow - serverUnavailableSince.Value
                        : TimeSpan.Zero;

                    // v1.1.2: Masaustu artik sunucuyu OTOMATIK baslatmaz.
                    // Sunucunun tek sahibi Windows Server Manager'dir. Restore/update
                    // sirasinda maintenance.lock varken yalniz bekler; boylece
                    // masaustu + restore motoru + manager arasinda yaris olusmaz.
                    if (IsMaintenanceActive())
                    {
                        splashText.Text = "KafePin yedekten geri yükleniyor / bakım yapılıyor... Yönetim paneli otomatik geri açılacak.";
                        retryButton.Visible = false;
                        if (!automaticRecoveryAttempted && unavailableFor.TotalSeconds >= 4)
                        {
                            automaticRecoveryAttempted = true;
                            KickServerManager();
                        }
                        if (unavailableFor.TotalSeconds >= 120)
                        {
                            splashText.Text = "Geri yükleme beklenenden uzun sürdü. Server Manager yeniden tetiklendi.";
                            retryButton.Text = "Server Manager'ı Onar";
                            retryButton.Visible = true;
                        }
                        return;
                    }

                    splashText.Text = "KafePin sunucusu yeniden başlatılıyor... Yönetim paneli otomatik geri açılacak.";

                    if (unavailableFor.TotalSeconds >= 30)
                    {
                        splashText.Text = "Sunucu henüz açılamadı. Otomatik ikinci başlatma yapılmadı; istersen aşağıdaki düğmeyle onarabilirsin.";
                        retryButton.Text = "Sunucuyu Onar";
                        retryButton.Visible = true;
                    }
                    else
                    {
                        retryButton.Visible = false;
                    }
                    return;
                }

                bool versionChanged = !string.IsNullOrWhiteSpace(lastServerVersion) &&
                    !string.IsNullOrWhiteSpace(version) &&
                    !string.Equals(lastServerVersion, version, StringComparison.OrdinalIgnoreCase);

                if (string.IsNullOrWhiteSpace(lastServerVersion) && !string.IsNullOrWhiteSpace(version))
                    lastServerVersion = version;

                if (serverWasUnavailable || versionChanged)
                {
                    serverWasUnavailable = false;
                    serverUnavailableSince = null;
                    automaticRecoveryAttempted = false;
                    if (!string.IsNullOrWhiteSpace(version)) lastServerVersion = version;
                    targetUrl = HomeUrl;
                    bool keepEmbeddedToolOpen = IsEmbeddedToolViewActive();
                    browser.Visible = false;
                    if (!keepEmbeddedToolOpen)
                    {
                        splash.Visible = true;
                        splash.BringToFront();
                        splashText.Text = "Sunucu hazır. Yönetim paneli açılıyor...";
                        retryButton.Visible = false;
                    }
                    try
                    {
                        WindowState = FormWindowState.Maximized;
                        Show();
                        BringToFront();
                        Activate();
                    }
                    catch { }

                    if (keepEmbeddedToolOpen)
                    {
                        try
                        {
                            if (browser.CoreWebView2 != null)
                            {
                                browser.CoreWebView2.Navigate(WithCacheBust(HomeUrl));
                            }
                            else
                            {
                                BeginInitialize();
                            }
                        }
                        catch { }
                    }
                    else
                    {
                        NavigateLocal(HomeUrl);
                    }
                }
            }
            catch { }
            finally { serverWatchBusy = false; }
        }

        private async Task<string> GetServerVersionOnceAsync()
        {
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3000/api/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    req.Method = "GET";
                    req.Timeout = 900;
                    req.ReadWriteTimeout = 900;
                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return null;
                        return resp.Headers["X-KafePin-Version"] ?? string.Empty;
                    }
                }
                catch { return null; }
            });
        }

        private async Task<bool> WaitForServerAsync(int maxSeconds)
        {
            int attempts = Math.Max(1, maxSeconds * 2);
            for (int i = 0; i < attempts; i++)
            {
                bool ok = await Task.Run(delegate
                {
                    try
                    {
                        HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3000/api/health");
                        req.Method = "GET";
                        req.Timeout = 1000;
                        req.ReadWriteTimeout = 1000;
                        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                        {
                            return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300;
                        }
                    }
                    catch { return false; }
                });
                if (ok) return true;
                await Task.Delay(500);
            }
            return false;
        }

        private void Browser_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                browser.Visible = true;
                if (!IsEmbeddedToolViewActive())
                {
                    splash.Visible = false;
                    browser.BringToFront();
                    try { UpdateNavButtons(browser.Source != null ? browser.Source.ToString() : targetUrl); } catch { }
                }
                hasLoadedOnce = true;
                initializing = false;
            }
            else
            {
                browser.Visible = false;
                if (!IsEmbeddedToolViewActive())
                {
                    splash.Visible = true;
                    splash.BringToFront();
                    splashText.Text = "KafePin ekranı yüklenemedi. Tekrar denenebilir.";
                    retryButton.Visible = true;
                }
                initializing = false;
            }
        }

        private void CoreWebView2_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsLocalKafePinUrl(e.Uri))
            {
                targetUrl = e.Uri;
                if (!IsEmbeddedToolViewActive()) UpdateNavButtons(e.Uri);
                return;
            }
            e.Cancel = true;
            OpenExternal(e.Uri);
        }

        private void CoreWebView2_NewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (IsLocalKafePinUrl(e.Uri))
            {
                targetUrl = e.Uri;
                browser.CoreWebView2.Navigate(e.Uri);
                return;
            }
            OpenExternal(e.Uri);
        }

        private static bool IsMp3BotUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != "http" && uri.Scheme != "https") return false;
            bool localHost = string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase);
            return localHost && uri.Port == 17890;
        }

        private static bool IsPrinterProUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != "http" && uri.Scheme != "https") return false;
            bool localHost = string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase);
            return localHost && uri.Port == 17891;
        }

        private bool IsEmbeddedToolViewActive()
        {
            return mp3ViewActive || printerViewActive || whatsAppViewActive || serviceViewActive;
        }

        private static bool IsLocalKafePinUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme == "about") return true;
            if (uri.Scheme != "http" && uri.Scheme != "https") return false;
            return string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase);
        }

        private static void OpenExternal(string url)
        {
            try { Process.Start(url); } catch { }
        }
    }
}
