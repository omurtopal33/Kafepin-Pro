using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Media;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
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
        private sealed class MessagingPanelDismissFilter : IMessageFilter
        {
            private readonly MainForm owner;

            internal MessagingPanelDismissFilter(MainForm ownerForm)
            {
                owner = ownerForm;
            }

            public bool PreFilterMessage(ref Message message)
            {
                if (message.Msg != 0x0201 && message.Msg != 0x0204 && message.Msg != 0x0207) return false;
                if (owner == null || owner.IsDisposed) return false;
                owner.CloseMessagingPanelOnOutsideClick();
                return false;
            }
        }

        private const string HomeUrl = "http://127.0.0.1:3000/kafepin-pro-yonetim.html";
        private const string AdminUrl = "http://127.0.0.1:3000/admin.html";
        private const string MonitorUrl = "http://127.0.0.1:3000/monitor.html";
        private const string EveryCafeSyncUrl = "http://127.0.0.1:3000/everycafe-sync.html";
        private const string EveryCafeHistoryUrl = "http://127.0.0.1:3000/everycafe-history.html";
        private const string EveryCafeIntegrationUrl = "http://127.0.0.1:3000/everycafe-integration.html";
        private const string Mp3BotUrl = "http://127.0.0.1:17890/";
        private const string Mp3BotRoot = @"C:\KafePinPro\MP3BotPRO";
        private const string PrinterProUrl = "http://127.0.0.1:17891/";
        private const string WhatsAppUrl = "https://web.whatsapp.com/";
        private const string TelegramWebUrl = "https://web.telegram.org/k/";
        private const string ServiceProUrl = "http://127.0.0.1:17892/";
        private const string ServiceProRoot = @"C:\KafePinPro\TeknikServisPRO";
        private const string ClientProUrl = "http://127.0.0.1:17894/";
        private const string ClientProRoot = @"C:\KafePinPro\ClientYonetimPRO";
        // Paketle birlikte gelen bağımsız servis. KafePin sunucusu/DB/session
        // katmanına erişmez; yalnız kendi loopback portunda çalışır.
        private const string PrinterProRoot = @"C:\KafePinPro\YaziciPRO";

        private readonly WebView2 browser;
        private readonly WebView2 mp3Browser;
        private readonly WebView2 printerBrowser;
        private readonly WebView2 whatsAppBrowser;
        private readonly WebView2 whatsAppPersonalBrowser;
        private readonly WebView2 telegramBrowser;
        private readonly Panel whatsAppPanel;
        private readonly Panel whatsAppResizeGrip;
        private readonly Button whatsAppSidebarToggleButton;
        private readonly Button messagingRefreshButton;
        private readonly NotifyIcon messagingNotifyIcon;
        private readonly IMessageFilter messagingPanelDismissFilter;
        private readonly WebView2 serviceBrowser;
        private readonly WebView2 clientBrowser;
        private readonly Panel appShellPanel;
        private readonly Panel contentPanel;
        private readonly Panel splash;
        private readonly Label splashTitle;
        private readonly Label splashText;
        private readonly Button retryButton;
        private readonly Label brandLabel;
        private readonly PictureBox brandLogo;
        private readonly Button managementButton;
        private readonly Button adminButton;
        private readonly Button monitorButton;
        private readonly Button everyCafeSyncButton;
        private readonly Button everyCafeHistoryButton;
        private readonly Button everyCafeIntegrationButton;
        private readonly Button mp3BotButton;
        private readonly Button printerProButton;
        private readonly Button serviceProButton;
        private readonly Button clientProButton;
        private readonly Button whatsAppTopButton;
        private readonly Button whatsAppPersonalTopButton;
        private readonly Button telegramTopButton;
        private readonly Label whatsAppBusinessBadge;
        private readonly Label whatsAppPersonalBadge;
        private readonly Label telegramBadge;
        private readonly Button refreshButton;
        private readonly Button proServicesRefreshButton;
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
        private bool whatsAppPersonalBrowserReady;
        private bool telegramBrowserReady;
        private bool whatsAppBrowserInitializing;
        private bool whatsAppPersonalBrowserInitializing;
        private bool telegramBrowserInitializing;
        private bool whatsAppBusinessNotificationPending;
        private bool whatsAppPersonalNotificationPending;
        private bool telegramNotificationPending;
        private string lastMessagingNotificationKey = string.Empty;
        private DateTime lastMessagingNotificationAt = DateTime.MinValue;
        private string lastMessagingNotificationTarget = string.Empty;
        private bool whatsAppViewActive;
        private bool whatsAppPersonalActive;
        private bool telegramActive;
        private bool whatsAppPanelResizing;
        private bool whatsAppPanelUserSized;
        private int whatsAppResizeStartX;
        private int whatsAppResizeStartWidth;
        private readonly string whatsAppSidebarSettingsPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "KafePinPro", "whatsapp-sidebar-width.txt");
        private readonly string telegramCacheRepairMarkerPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "KafePinPro", "telegram-cache-repair-v1.txt");
        private bool serviceBrowserReady;
        private bool serviceViewActive;
        private bool clientBrowserReady;
        private bool clientViewActive;
        private CoreWebView2Environment sharedWebViewEnvironment;
        private Task<CoreWebView2Environment> sharedWebViewEnvironmentTask;
        private Task<CoreWebView2Environment> whatsAppPersonalEnvironmentTask;
        private Task<CoreWebView2Environment> telegramEnvironmentTask;
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

            brandLabel = new Label();
            brandLabel.Text = "KafePin Pro";
            brandLabel.ForeColor = Color.FromArgb(105, 236, 183);
            brandLabel.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
            brandLabel.AutoSize = false;
            brandLabel.TextAlign = ContentAlignment.MiddleLeft;
            brandLabel.SetBounds(12, 8, 150, 40);
            brandLabel.Cursor = Cursors.Hand;
            brandLabel.Click += SelectCafeBrandLogo;
            topBar.Controls.Add(brandLabel);

            brandLogo = new PictureBox();
            brandLogo.SetBounds(8, 8, 112, 40);
            brandLogo.SizeMode = PictureBoxSizeMode.Zoom;
            brandLogo.BackColor = Color.Transparent;
            brandLogo.Cursor = Cursors.Hand;
            brandLogo.Visible = false;
            brandLogo.Click += SelectCafeBrandLogo;
            topBar.Controls.Add(brandLogo);
            LoadCafeBrandLogo();

            managementButton = MakeNavButton("Yönetim", 160, 12, 100);
            adminButton = MakeNavButton("Admin", 268, 12, 70);
            monitorButton = MakeNavButton("Monitör", 346, 12, 76);
            everyCafeSyncButton = MakeNavButton("EveryCafe Senkron", 430, 12, 124);
            everyCafeHistoryButton = MakeNavButton("Geçmiş Aktarım", 562, 12, 120);
            everyCafeIntegrationButton = MakeNavButton("Entegrasyon Günlüğü", 690, 12, 136);
            mp3BotButton = MakeNavButton("🎵 MP3 Bot PRO", 834, 12, 132);
            printerProButton = MakeNavButton("🖨️ Yazıcı PRO", 974, 12, 128);
            serviceProButton = MakeNavButton("🛠 Teknik Servis PRO", 1110, 12, 150);
            clientProButton = MakeNavButton("🖥 Client Yönetim PRO", 1268, 12, 152);
            ApplyEveryCafeNavigationVisibility();
            whatsAppTopButton = MakeNavButton("WA Business", 1428, 12, 112);
            whatsAppPersonalTopButton = MakeNavButton("WA Kişisel", 1548, 12, 106);
            telegramTopButton = MakeNavButton("Telegram", 1662, 12, 90);
            refreshButton = MakeNavButton("Yenile", 1568, 12, 70);
            proServicesRefreshButton = MakeNavButton("↻ PRO Servisleri", 1646, 12, 108);

            whatsAppBusinessBadge = MakeNotificationBadge();
            whatsAppPersonalBadge = MakeNotificationBadge();
            telegramBadge = MakeNotificationBadge();
            whatsAppBusinessBadge.Click += delegate { whatsAppTopButton.PerformClick(); };
            whatsAppPersonalBadge.Click += delegate { whatsAppPersonalTopButton.PerformClick(); };
            telegramBadge.Click += delegate { telegramTopButton.PerformClick(); };

            managementButton.Click += delegate { NavigateLocal(HomeUrl); };
            adminButton.Click += delegate { NavigateLocal(AdminUrl); };
            monitorButton.Click += delegate { NavigateLocal(MonitorUrl); };
            everyCafeSyncButton.Click += delegate { NavigateLocal(EveryCafeSyncUrl); };
            everyCafeHistoryButton.Click += delegate { NavigateLocal(EveryCafeHistoryUrl); };
            everyCafeIntegrationButton.Click += delegate { NavigateLocal(EveryCafeIntegrationUrl); };
            mp3BotButton.Click += Mp3BotButton_Click;
            printerProButton.Click += PrinterProButton_Click;
            serviceProButton.Click += ServiceProButton_Click;
            clientProButton.Click += ClientProButton_Click;
            whatsAppTopButton.Click += async delegate
            {
                if (whatsAppViewActive && !whatsAppPersonalActive && !telegramActive) { CloseWhatsAppPanel(); return; }
                try { await EnsureWhatsAppBrowserAsync(); ShowWhatsAppView(); }
                catch (Exception ex) { MessageBox.Show("WhatsApp Web açılamadı:\n" + ex.Message, "KafePin Pro", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            };
            whatsAppPersonalTopButton.Click += async delegate
            {
                if (whatsAppViewActive && whatsAppPersonalActive) { CloseWhatsAppPanel(); return; }
                try { await EnsureWhatsAppPersonalBrowserAsync(); ShowWhatsAppPersonalView(); }
                catch (Exception ex) { MessageBox.Show("Kişisel WhatsApp açılamadı:\n" + ex.Message, "KafePin Pro", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            };
            telegramTopButton.Click += async delegate
            {
                if (whatsAppViewActive && telegramActive) { CloseWhatsAppPanel(); return; }
                try { await EnsureTelegramBrowserAsync(); ShowTelegramView(); }
                catch (Exception ex) { MessageBox.Show("Telegram Web açılamadı:\n" + ex.Message, "KafePin Pro", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            };
            EventHandler screenRefreshAction = async delegate
            {
                try
                {
                    ApplyEveryCafeNavigationVisibility();
                    LayoutTopNavigation(topBar, brandLabel);
                    if (whatsAppViewActive)
                    {
                        await ReloadActiveMessagingViewAsync();
                        return;
                    }
                    if (mp3ViewActive && mp3Browser.CoreWebView2 != null)
                    {
                        await mp3Browser.CoreWebView2.ExecuteScriptAsync(
                            "window.kafePinPrepareReload ? window.kafePinPrepareReload() : false;"
                        );
                        mp3Browser.CoreWebView2.Reload();
                        return;
                    }
                    if (printerViewActive && printerBrowser.CoreWebView2 != null) { printerBrowser.CoreWebView2.Reload(); return; }
                    if (serviceViewActive && serviceBrowser.CoreWebView2 != null) { serviceBrowser.CoreWebView2.Reload(); return; }
                    if (clientViewActive && clientBrowser.CoreWebView2 != null) { clientBrowser.CoreWebView2.Reload(); return; }
                    NavigateLocal(targetUrl);
                }
                catch { }
            };
            refreshButton.Click += screenRefreshAction;
            proServicesRefreshButton.Click += ProServicesRefreshMenuItem_Click;

            topBar.Controls.Add(managementButton);
            topBar.Controls.Add(adminButton);
            topBar.Controls.Add(monitorButton);
            topBar.Controls.Add(everyCafeSyncButton);
            topBar.Controls.Add(everyCafeHistoryButton);
            topBar.Controls.Add(everyCafeIntegrationButton);
            topBar.Controls.Add(mp3BotButton);
            topBar.Controls.Add(printerProButton);
            topBar.Controls.Add(serviceProButton);
            topBar.Controls.Add(clientProButton);
            topBar.Controls.Add(whatsAppTopButton);
            topBar.Controls.Add(whatsAppPersonalTopButton);
            topBar.Controls.Add(telegramTopButton);
            topBar.Controls.Add(refreshButton);
            topBar.Controls.Add(proServicesRefreshButton);
            topBar.Controls.Add(whatsAppBusinessBadge);
            topBar.Controls.Add(whatsAppPersonalBadge);
            topBar.Controls.Add(telegramBadge);
            whatsAppBusinessBadge.BringToFront();
            whatsAppPersonalBadge.BringToFront();
            telegramBadge.BringToFront();
            LayoutWhatsAppBadges();

            Label hint = new Label();
            hint.Text = "Masaüstü uygulaması";
            hint.ForeColor = Color.FromArgb(130, 155, 176);
            hint.Font = new Font("Segoe UI", 9F, FontStyle.Regular);
            hint.AutoSize = false;
            hint.TextAlign = ContentAlignment.MiddleRight;
            hint.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            hint.SetBounds(Math.Max(1052, ClientSize.Width - 138), 8, 128, 40);
            topBar.Controls.Add(hint);
            topBar.Resize += delegate
            {
                hint.Visible = false;
                LayoutTopNavigation(topBar, brandLabel);
            };
            LayoutTopNavigation(topBar, brandLabel);

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

            whatsAppPanel = new Panel();
            whatsAppPanel.Dock = DockStyle.None;
            whatsAppPanel.Width = 900;
            whatsAppPanel.MinimumSize = new Size(600, 0);
            whatsAppPanel.BackColor = Color.FromArgb(12, 23, 34);
            whatsAppPanel.BorderStyle = BorderStyle.FixedSingle;
            whatsAppPanel.Visible = false;

            whatsAppBrowser = new WebView2();
            whatsAppBrowser.Dock = DockStyle.Fill;
            whatsAppBrowser.Visible = true;
            whatsAppPanel.Controls.Add(whatsAppBrowser);

            whatsAppPersonalBrowser = new WebView2();
            whatsAppPersonalBrowser.Dock = DockStyle.Fill;
            whatsAppPersonalBrowser.Visible = false;
            whatsAppPanel.Controls.Add(whatsAppPersonalBrowser);

            telegramBrowser = new WebView2();
            telegramBrowser.Dock = DockStyle.Fill;
            telegramBrowser.Visible = false;
            whatsAppPanel.Controls.Add(telegramBrowser);

            whatsAppResizeGrip = new Panel();
            whatsAppResizeGrip.Dock = DockStyle.Right;
            whatsAppResizeGrip.Width = 7;
            whatsAppResizeGrip.BackColor = Color.FromArgb(49, 92, 116);
            whatsAppResizeGrip.Cursor = Cursors.SizeWE;
            whatsAppResizeGrip.MouseDown += WhatsAppResizeGrip_MouseDown;
            whatsAppResizeGrip.MouseMove += WhatsAppResizeGrip_MouseMove;
            whatsAppResizeGrip.MouseUp += WhatsAppResizeGrip_MouseUp;
            whatsAppResizeGrip.DoubleClick += delegate { whatsAppPanelUserSized = false; SaveWhatsAppSidebarWidth(); LayoutWhatsAppPanel(); };
            whatsAppPanel.Controls.Add(whatsAppResizeGrip);
            whatsAppResizeGrip.BringToFront();

            messagingRefreshButton = new Button();
            messagingRefreshButton.Text = "↻";
            messagingRefreshButton.Size = new Size(38, 34);
            messagingRefreshButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            messagingRefreshButton.FlatStyle = FlatStyle.Flat;
            messagingRefreshButton.FlatAppearance.BorderColor = Color.FromArgb(70, 200, 143);
            messagingRefreshButton.BackColor = Color.FromArgb(20, 99, 67);
            messagingRefreshButton.ForeColor = Color.White;
            messagingRefreshButton.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
            messagingRefreshButton.Cursor = Cursors.Hand;
            messagingRefreshButton.TabStop = false;
            messagingRefreshButton.Click += async delegate { await ReloadActiveMessagingViewAsync(); };
            whatsAppPanel.Controls.Add(messagingRefreshButton);
            messagingRefreshButton.BringToFront();
            contentPanel.Controls.Add(whatsAppPanel);
            LoadWhatsAppSidebarWidth();

            messagingNotifyIcon = new NotifyIcon();
            messagingNotifyIcon.Icon = Icon ?? SystemIcons.Application;
            messagingNotifyIcon.Text = "KafePin Pro Mesaj Bildirimleri";
            messagingNotifyIcon.Visible = true;
            messagingNotifyIcon.BalloonTipClicked += async delegate
            {
                try
                {
                    if (lastMessagingNotificationTarget == "personal") { await EnsureWhatsAppPersonalBrowserAsync(); ShowWhatsAppPersonalView(); }
                    else if (lastMessagingNotificationTarget == "telegram") { await EnsureTelegramBrowserAsync(); ShowTelegramView(); }
                    else { await EnsureWhatsAppBrowserAsync(); ShowWhatsAppView(); }
                    WindowState = FormWindowState.Maximized;
                    Activate();
                }
                catch { }
            };

            serviceBrowser = new WebView2();
            serviceBrowser.Dock = DockStyle.Fill;
            serviceBrowser.Visible = false;
            contentPanel.Controls.Add(serviceBrowser);

            clientBrowser = new WebView2();
            clientBrowser.Dock = DockStyle.Fill;
            clientBrowser.Visible = false;
            contentPanel.Controls.Add(clientBrowser);

            splash = new Panel();
            splash.Dock = DockStyle.Fill;
            splash.BackColor = Color.FromArgb(9, 13, 20);
            contentPanel.Controls.Add(splash);
            splash.BringToFront();

            whatsAppSidebarToggleButton = new Button();
            whatsAppSidebarToggleButton.Text = "☎";
            whatsAppSidebarToggleButton.SetBounds(0, 150, 48, 52);
            whatsAppSidebarToggleButton.Visible = false;
            whatsAppSidebarToggleButton.FlatStyle = FlatStyle.Flat;
            whatsAppSidebarToggleButton.FlatAppearance.BorderColor = Color.FromArgb(57, 177, 119);
            whatsAppSidebarToggleButton.BackColor = Color.FromArgb(20, 99, 67);
            whatsAppSidebarToggleButton.ForeColor = Color.White;
            whatsAppSidebarToggleButton.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            whatsAppSidebarToggleButton.Cursor = Cursors.Hand;
            whatsAppSidebarToggleButton.Click += async delegate
            {
                try
                {
                    await EnsureWhatsAppBrowserAsync();
                    ShowWhatsAppView();
                }
                catch (Exception ex)
                {
                    MessageBox.Show("WhatsApp Web açılamadı:\n" + ex.Message, "KafePin Pro", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            };
            contentPanel.Controls.Add(whatsAppSidebarToggleButton);

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

            appShellPanel = new Panel();
            appShellPanel.Dock = DockStyle.None;
            appShellPanel.BackColor = Color.FromArgb(9, 13, 20);
            appShellPanel.Controls.Add(contentPanel);
            appShellPanel.Controls.Add(topBar);
            Controls.Add(appShellPanel);
            Controls.Add(whatsAppPanel);

            messagingPanelDismissFilter = new MessagingPanelDismissFilter(this);
            Application.AddMessageFilter(messagingPanelDismissFilter);

            serverWatchTimer = new System.Windows.Forms.Timer();
            serverWatchTimer.Interval = 1500;
            serverWatchTimer.Tick += ServerWatchTimer_Tick;

            contentPanel.Resize += delegate { LayoutSplash(); };
            Resize += delegate
            {
                LayoutTopNavigation(topBar, brandLabel);
                LayoutWhatsAppPanel();
                LayoutWhatsAppSidebarToggle();
            };
            Shown += async delegate
            {
                ApplyEveryCafeNavigationVisibility();
                BeginInvoke(new Action(delegate { LayoutTopNavigation(topBar, brandLabel); }));
                BeginInitialize();
                serverWatchTimer.Start();
                await WarmMessagingBrowsersAsync();
            };
            FormClosing += delegate { try { Application.RemoveMessageFilter(messagingPanelDismissFilter); } catch { } try { serverWatchTimer.Stop(); } catch { } try { messagingNotifyIcon.Visible = false; messagingNotifyIcon.Dispose(); } catch { } try { browser.Dispose(); } catch { } try { mp3Browser.Dispose(); } catch { } try { printerBrowser.Dispose(); } catch { } try { whatsAppBrowser.Dispose(); } catch { } try { whatsAppPersonalBrowser.Dispose(); } catch { } try { telegramBrowser.Dispose(); } catch { } try { clientBrowser.Dispose(); } catch { } };
            LayoutSplash();
            LayoutWhatsAppSidebarToggle();
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

        private Label MakeNotificationBadge()
        {
            Label badge = new Label();
            badge.AutoSize = false;
            badge.Size = new Size(27, 18);
            badge.TextAlign = ContentAlignment.MiddleCenter;
            badge.BackColor = Color.FromArgb(218, 48, 60);
            badge.ForeColor = Color.White;
            badge.Font = new Font("Segoe UI", 8F, FontStyle.Bold);
            badge.Visible = false;
            badge.Cursor = Cursors.Hand;
            return badge;
        }

        private string GetCafeBrandingDirectory()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "KafePinPro", "branding");
        }

        private void LoadCafeBrandLogo()
        {
            try
            {
                string directory = GetCafeBrandingDirectory();
                string[] candidates = new string[] {
                    Path.Combine(directory, "cafe-logo.png"),
                    Path.Combine(directory, "cafe-logo.jpg"),
                    Path.Combine(directory, "cafe-logo.jpeg"),
                    Path.Combine(directory, "cafe-logo.bmp")
                };
                string selected = null;
                foreach (string candidate in candidates)
                {
                    if (!File.Exists(candidate)) continue;
                    selected = candidate;
                    break;
                }
                if (string.IsNullOrWhiteSpace(selected))
                {
                    brandLogo.Visible = false;
                    brandLabel.Visible = true;
                    return;
                }
                using (FileStream stream = new FileStream(selected, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (Image source = Image.FromStream(stream))
                {
                    Image old = brandLogo.Image;
                    brandLogo.Image = new Bitmap(source);
                    if (old != null) old.Dispose();
                }
                brandLabel.Visible = false;
                brandLogo.Visible = true;
            }
            catch
            {
                brandLogo.Visible = false;
                brandLabel.Visible = true;
            }
        }

        private void SelectCafeBrandLogo(object sender, EventArgs e)
        {
            try
            {
                using (OpenFileDialog dialog = new OpenFileDialog())
                {
                    dialog.Title = "Kafe logosunu seç";
                    dialog.Filter = "Logo dosyaları|*.png;*.jpg;*.jpeg;*.bmp|PNG|*.png|JPEG|*.jpg;*.jpeg|Bitmap|*.bmp";
                    dialog.Multiselect = false;
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    FileInfo info = new FileInfo(dialog.FileName);
                    if (info.Length <= 0 || info.Length > 5L * 1024L * 1024L)
                        throw new InvalidOperationException("Logo en fazla 5 MB olabilir.");
                    string extension = info.Extension.ToLowerInvariant();
                    if (extension != ".png" && extension != ".jpg" && extension != ".jpeg" && extension != ".bmp")
                        throw new InvalidOperationException("Logo PNG, JPG, JPEG veya BMP olmalı.");
                    byte[] logoBytes = File.ReadAllBytes(dialog.FileName);
                    string directory = GetCafeBrandingDirectory();
                    Directory.CreateDirectory(directory);
                    foreach (string oldLogo in Directory.GetFiles(directory, "cafe-logo.*"))
                    {
                        try { File.Delete(oldLogo); } catch { }
                    }
                    File.WriteAllBytes(Path.Combine(directory, "cafe-logo" + extension), logoBytes);
                    LoadCafeBrandLogo();
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Logo kaydedilemedi:\n" + ex.Message, "KafePin Pro", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void LayoutTopNavigation(Panel topBar, Label brand)
        {
            // Form ilk oluşurken Dock yerleşimi tamamlanmadan geçici olarak çok dar
            // bir genişlik raporlanabilir. Bu geçici değerle düğmeleri 30 piksele
            // sıkıştırmak yerine Shown/Resize turundaki gerçek genişliği bekle.
            if (topBar.ClientSize.Width < 700) return;
            Button[] buttons = new Button[] {
                managementButton, adminButton, monitorButton, everyCafeSyncButton,
                everyCafeHistoryButton, everyCafeIntegrationButton, mp3BotButton,
                printerProButton, serviceProButton, clientProButton,
                whatsAppTopButton, whatsAppPersonalTopButton, telegramTopButton, refreshButton,
                proServicesRefreshButton
            };
            string[] fullText = new string[] {
                "Yönetim", "Admin", "Monitör", "EveryCafe Senkron", "Geçmiş Aktarım",
                "Entegrasyon Günlüğü", "🎵 MP3 Bot PRO", "🖨 Yazıcı PRO",
                "🛠 Teknik Servis PRO", "🖥 Client Yönetim PRO",
                "WA Business", "WA Kişisel", "Telegram", "Yenile", "↻ PRO Servisleri"
            };
            string[] compactText = new string[] {
                "Yönetim", "Admin", "Monitör", "Senkron", "Geçmiş", "Günlük",
                "MP3", "Yazıcı", "Teknik", "Client", "WA B", "WA K", "TG", "Yenile", "↻ PRO"
            };
            int[] fullWidth = new int[] { 100,70,76,124,120,136,132,128,150,152,112,106,90,70,108 };
            int[] compactWidth = new int[] { 58,46,52,58,55,52,48,52,52,52,48,48,42,48,52 };

            int totalWidth = Math.Max(1, topBar.ClientSize.Width);
            bool compact = totalWidth < 1400;
            brand.Visible = !compact && brandLogo.Image == null;
            brandLogo.Visible = !compact && brandLogo.Image != null;
            brand.Width = 118;
            int x = compact ? 4 : 126;
            int gap = compact ? 2 : 4;
            int[] desired = compact ? compactWidth : fullWidth;
            string[] labels = compact ? compactText : fullText;
            int visibleCount = 0;
            int desiredTotal = 0;
            for (int i=0; i<desired.Length; i++)
            {
                if (!buttons[i].Visible) continue;
                desiredTotal += desired[i];
                visibleCount++;
            }
            int available = Math.Max(1, totalWidth - x - 4 - gap * Math.Max(0, visibleCount - 1));
            double scale = Math.Min(1.0, (double)available / Math.Max(1, desiredTotal));
            float fontSize = compact ? (scale < 0.82 ? 6.5F : 7.5F) : 8.5F;

            for (int i=0; i<buttons.Length; i++)
            {
                if (!buttons[i].Visible) continue;
                int width = Math.Max(30, (int)Math.Floor(desired[i] * scale));
                buttons[i].Text = labels[i];
                buttons[i].Font = new Font("Segoe UI", fontSize, FontStyle.Bold);
                buttons[i].SetBounds(x, 12, width, 34);
                x += width + gap;
            }
            LayoutWhatsAppBadges();
        }

        private bool IsClientProEnabledForThisCafe()
        {
            try
            {
                string statePath = Path.Combine(GetKafePinRoot(), "config", "pro-components.json");
                if (File.Exists(statePath))
                {
                    string state = File.ReadAllText(statePath);
                    if (System.Text.RegularExpressions.Regex.IsMatch(
                        state,
                        "\\\"client\\\"\\s*:\\s*true",
                        System.Text.RegularExpressions.RegexOptions.IgnoreCase
                    )) return true;
                }
                string proRoot = Path.Combine(Path.GetPathRoot(GetKafePinRoot()) ?? "C:\\", "KafePinPro", "ClientYonetimPRO");
                return File.Exists(Path.Combine(proRoot, "web_service.py"));
            }
            catch { return false; }
        }

        private bool IsEveryCafeEnabledForThisCafe()
        {
            try
            {
                string envPath = Path.Combine(GetKafePinRoot(), ".env");
                if (File.Exists(envPath))
                {
                    foreach (string rawLine in File.ReadAllLines(envPath))
                    {
                        string line = (rawLine ?? string.Empty).Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        int equalsIndex = line.IndexOf('=');
                        if (equalsIndex <= 0) continue;
                        string key = line.Substring(0, equalsIndex).Trim();
                        if (!key.Equals("EVERYCAFE_DB_PATH", StringComparison.OrdinalIgnoreCase)) continue;
                        string value = line.Substring(equalsIndex + 1).Trim().Trim('"');
                        if (string.IsNullOrWhiteSpace(value)) return false;
                        return value.IndexOf("everycafe-disabled.ecm", StringComparison.OrdinalIgnoreCase) < 0;
                    }
                }
                return File.Exists(@"C:\Program Files (x86)\EveryCafeManager\ecmdata.ecm");
            }
            catch { }
            return false;
        }

        private void ApplyEveryCafeNavigationVisibility()
        {
            bool everyCafeEnabled = IsEveryCafeEnabledForThisCafe();
            everyCafeSyncButton.Visible = everyCafeEnabled;
            everyCafeHistoryButton.Visible = everyCafeEnabled;
            everyCafeIntegrationButton.Visible = everyCafeEnabled;
            // Client Yönetim PRO hem EveryCafe kullanılıyor hem de kurulumda
            // bileşen açıkça seçilmişse görünür. Klasör kalıntısı yetmez.
            clientProButton.Visible = everyCafeEnabled && IsClientProEnabledForThisCafe();

            if (!everyCafeEnabled &&
                (targetUrl.Equals(EveryCafeSyncUrl, StringComparison.OrdinalIgnoreCase) ||
                 targetUrl.Equals(EveryCafeHistoryUrl, StringComparison.OrdinalIgnoreCase) ||
                 targetUrl.Equals(EveryCafeIntegrationUrl, StringComparison.OrdinalIgnoreCase)))
            {
                targetUrl = HomeUrl;
            }
        }

        private void LayoutWhatsAppBadges()
        {
            if (whatsAppBusinessBadge == null || whatsAppPersonalBadge == null || telegramBadge == null) return;
            whatsAppBusinessBadge.Left = whatsAppTopButton.Right - whatsAppBusinessBadge.Width + 4;
            whatsAppBusinessBadge.Top = 4;
            whatsAppPersonalBadge.Left = whatsAppPersonalTopButton.Right - whatsAppPersonalBadge.Width + 4;
            whatsAppPersonalBadge.Top = 4;
            telegramBadge.Left = telegramTopButton.Right - telegramBadge.Width + 4;
            telegramBadge.Top = 4;
            whatsAppBusinessBadge.BringToFront();
            whatsAppPersonalBadge.BringToFront();
            telegramBadge.BringToFront();
        }

        private static int ParseWhatsAppUnreadCount(string title)
        {
            if (string.IsNullOrWhiteSpace(title)) return 0;
            for (int open = title.IndexOf('('); open >= 0; open = title.IndexOf('(', open + 1))
            {
                int close = title.IndexOf(')', open + 1);
                if (close <= open + 1) continue;
                int count;
                if (int.TryParse(title.Substring(open + 1, close - open - 1).Trim(), out count))
                    return Math.Max(0, count);
            }
            return 0;
        }

        private void UpdateWhatsAppBadge(bool personal, string documentTitle)
        {
            int count = ParseWhatsAppUnreadCount(documentTitle);
            Label badge = personal ? whatsAppPersonalBadge : whatsAppBusinessBadge;
            bool pending = personal ? whatsAppPersonalNotificationPending : whatsAppBusinessNotificationPending;
            badge.Text = count > 99 ? "99+" : count > 0 ? count.ToString() : "•";
            badge.Visible = count > 0 || pending;
            LayoutWhatsAppBadges();
        }

        private void UpdateTelegramBadge(string documentTitle)
        {
            int count = ParseWhatsAppUnreadCount(documentTitle);
            telegramBadge.Text = count > 99 ? "99+" : count > 0 ? count.ToString() : "•";
            telegramBadge.Visible = count > 0 || telegramNotificationPending;
            LayoutWhatsAppBadges();
        }

        private void MarkMessagingNotification(string target)
        {
            if (target == "personal") whatsAppPersonalNotificationPending = true;
            else if (target == "telegram") telegramNotificationPending = true;
            else whatsAppBusinessNotificationPending = true;

            if (target == "personal") UpdateWhatsAppBadge(true, whatsAppPersonalBrowser.CoreWebView2 == null ? "" : whatsAppPersonalBrowser.CoreWebView2.DocumentTitle);
            else if (target == "telegram") UpdateTelegramBadge(telegramBrowser.CoreWebView2 == null ? "" : telegramBrowser.CoreWebView2.DocumentTitle);
            else UpdateWhatsAppBadge(false, whatsAppBrowser.CoreWebView2 == null ? "" : whatsAppBrowser.CoreWebView2.DocumentTitle);
        }

        private void ClearMessagingNotification(string target)
        {
            if (target == "personal") whatsAppPersonalNotificationPending = false;
            else if (target == "telegram") telegramNotificationPending = false;
            else whatsAppBusinessNotificationPending = false;
        }

        private void ShowMessagingNotification(string target, string sourceLabel, CoreWebView2Notification notification)
        {
            string title = notification == null ? "Yeni mesaj" : (notification.Title ?? "Yeni mesaj");
            string body = notification == null ? "Yeni mesajınız var." : (notification.Body ?? "Yeni mesajınız var.");
            string key = target + "|" + title + "|" + body;
            DateTime now = DateTime.UtcNow;
            if (key == lastMessagingNotificationKey && (now - lastMessagingNotificationAt).TotalSeconds < 4) return;
            lastMessagingNotificationKey = key;
            lastMessagingNotificationAt = now;
            lastMessagingNotificationTarget = target;
            MarkMessagingNotification(target);
            PlayMessagingAlertSound();
            try
            {
                messagingNotifyIcon.BalloonTipTitle = sourceLabel + " • " + title;
                messagingNotifyIcon.BalloonTipText = string.IsNullOrWhiteSpace(body) ? "Yeni mesajınız var." : body;
                messagingNotifyIcon.BalloonTipIcon = ToolTipIcon.Info;
                messagingNotifyIcon.ShowBalloonTip(7000);
            }
            catch { }
        }

        private static void PlayMessagingAlertSound()
        {
            // WebView2 bildirimi uygulama tarafından ele alındığı için Windows her
            // makinede duyulur bir ses çalmayabiliyor. WhatsApp Business, Kişisel
            // ve Telegram için kısa çift uyarı mevcut ana/sistem sesini kullanır.
            try { SystemSounds.Exclamation.Play(); } catch { }
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Thread.Sleep(220);
                    SystemSounds.Exclamation.Play();
                }
                catch { }
            });
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
            SetActive(everyCafeIntegrationButton, !mp3ViewActive && !printerViewActive && !serviceViewActive && !clientViewActive && (value.EndsWith("/everycafe-integration.html") || value.Contains("/everycafe-integration.html?")));
            SetActive(mp3BotButton, mp3ViewActive || value.StartsWith("http://127.0.0.1:17890") || value.StartsWith("http://localhost:17890"));
            SetActive(printerProButton, printerViewActive || value.StartsWith("http://127.0.0.1:17891") || value.StartsWith("http://localhost:17891"));
            SetActive(serviceProButton, serviceViewActive || value.StartsWith("http://127.0.0.1:17892") || value.StartsWith("http://localhost:17892"));
            SetActive(clientProButton, clientViewActive || value.StartsWith("http://127.0.0.1:17894") || value.StartsWith("http://localhost:17894"));
            SetActive(whatsAppTopButton, whatsAppViewActive && !whatsAppPersonalActive && !telegramActive);
            SetActive(whatsAppPersonalTopButton, whatsAppViewActive && whatsAppPersonalActive && !telegramActive);
            SetActive(telegramTopButton, whatsAppViewActive && telegramActive);
            if (mp3ViewActive || printerViewActive || serviceViewActive || clientViewActive)
            {
                SetActive(managementButton, false);
                SetActive(adminButton, false);
                SetActive(monitorButton, false);
                SetActive(everyCafeSyncButton, false);
                SetActive(everyCafeHistoryButton, false);
                SetActive(everyCafeIntegrationButton, false);
            }
        }

        private async Task StopProComponentProcessesAsync()
        {
            // Yalnız C:\KafePinPro altındaki bağımsız Python/Node süreçlerini kapatır.
            // KafePin çekirdek node.exe süreci ve mesajlaşma WebView2 oturumları kapsam dışıdır.
            string script =
                "$roots=@('c:\\kafepinpro\\mp3botpro','c:\\kafepinpro\\yazicipro','c:\\kafepinpro\\teknikservispro','c:\\kafepinpro\\clientyonetimpro');" +
                "$self=$PID; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {" +
                "$n=([string]$_.Name).ToLowerInvariant();$c=([string]$_.CommandLine).ToLowerInvariant();" +
                "$ok=($n -eq 'python.exe' -or $n -eq 'pythonw.exe' -or $n -eq 'node.exe');" +
                "$hit=$false;foreach($r in $roots){if($c.Contains($r)){$hit=$true;break}};" +
                "$ok -and $hit -and ([int]$_.ProcessId -ne [int]$self)} | ForEach-Object {" +
                "Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue}";
            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded);
            psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process process = Process.Start(psi))
            {
                if (process != null) await Task.Run(() => process.WaitForExit(12000));
            }
            await Task.Delay(900);
        }

        private static void StartPythonWebService(string root)
        {
            string service = Path.Combine(root, "web_service.py");
            if (!File.Exists(service)) throw new FileNotFoundException("PRO servis dosyası bulunamadı.", service);
            string pythonw = Path.Combine(root, ".venv", "Scripts", "pythonw.exe");
            ProcessStartInfo psi;
            if (File.Exists(pythonw)) psi = new ProcessStartInfo(pythonw, "-B \"" + service + "\"");
            else psi = new ProcessStartInfo("py.exe", "-3 -B \"" + service + "\"");
            psi.WorkingDirectory = root; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
        }

        private async void ProServicesRefreshMenuItem_Click(object sender, EventArgs e)
        {
            proServicesRefreshButton.Enabled = false;
            proServicesRefreshButton.Text = "↻ Başlatılıyor...";
            try
            {
                await StopProComponentProcessesAsync();
                string report = string.Empty;

                string mp3Launcher = Path.Combine(Mp3BotRoot, "START_WEB.ps1");
                if (File.Exists(mp3Launcher))
                {
                    ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + mp3Launcher + "\"");
                    psi.WorkingDirectory = Mp3BotRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                    report += await WaitForMp3BotAsync(30) ? "MP3 Bot PRO: yeniden başlatıldı\n" : "MP3 Bot PRO: başlatılamadı\n";
                }
                else report += "MP3 Bot PRO: kurulu değil\n";

                string printerHost = Path.Combine(PrinterProRoot, "KafePin_YaziciPRO_ServiceHost.ps1");
                if (File.Exists(printerHost))
                {
                    ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + printerHost + "\" -InstallRoot \"" + PrinterProRoot + "\"");
                    psi.WorkingDirectory = PrinterProRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                    report += await WaitForPrinterProAsync(150) ? "Yazıcı PRO: yeniden başlatıldı\n" : "Yazıcı PRO: başlatılamadı\n";
                }
                else report += "Yazıcı PRO: kurulu değil\n";

                if (File.Exists(Path.Combine(ServiceProRoot, "web_service.py")))
                {
                    StartPythonWebService(ServiceProRoot);
                    for (int i = 0; i < 40 && !await IsServiceProReadyAsync(); i++) await Task.Delay(500);
                    report += await IsServiceProReadyAsync() ? "Teknik Servis PRO: yeniden başlatıldı\n" : "Teknik Servis PRO: başlatılamadı\n";
                }
                else report += "Teknik Servis PRO: kurulu değil\n";

                if (File.Exists(Path.Combine(ClientProRoot, "web_service.py")))
                {
                    StartPythonWebService(ClientProRoot);
                    for (int i = 0; i < 40 && !await IsClientProReadyAsync(); i++) await Task.Delay(500);
                    report += await IsClientProReadyAsync() ? "Client Yönetim PRO: yeniden başlatıldı\n" : "Client Yönetim PRO: başlatılamadı\n";
                }
                else report += "Client Yönetim PRO: kurulu değil\n";

                if (mp3ViewActive && mp3Browser.CoreWebView2 != null) mp3Browser.CoreWebView2.Reload();
                if (printerViewActive && printerBrowser.CoreWebView2 != null) printerBrowser.CoreWebView2.Reload();
                if (serviceViewActive && serviceBrowser.CoreWebView2 != null) serviceBrowser.CoreWebView2.Reload();
                if (clientViewActive && clientBrowser.CoreWebView2 != null) clientBrowser.CoreWebView2.Reload();
                MessageBox.Show(report.TrimEnd(), "KafePin PRO Servisleri", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("PRO servisleri yeniden başlatılamadı:\n" + ex.Message, "KafePin PRO Servisleri", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                proServicesRefreshButton.Text = "↻ PRO Servisleri";
                proServicesRefreshButton.Enabled = true;
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
                    string host = Path.Combine(PrinterProRoot, "KafePin_YaziciPRO_ServiceHost.ps1");
                    if (!File.Exists(host)) throw new InvalidOperationException("Yazıcı PRO servis başlatıcısı bulunamadı: " + host);
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "powershell.exe";
                    psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + host + "\" -InstallRoot \"" + PrinterProRoot + "\"";
                    psi.WorkingDirectory = PrinterProRoot;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process hostProcess = Process.Start(psi);
                    if (hostProcess == null) throw new InvalidOperationException("Yazıcı PRO servis başlatıcısı çalıştırılamadı.");

                    // v3.1.59: Servis host process'inin kapanmasını bekleme. İlk kurulumda
                    // Python onarımı 50 saniyeyi aşabilir. Eski kod 50. saniyede host'u
                    // öldürüp sahada yanlış timeout veriyordu. Gerçek kriter 17891+17893.
                    bool ready = await WaitForPrinterProAsync(150);
                    if (!ready)
                    {
                        string detail = string.Empty;
                        try
                        {
                            string logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KafePinYaziciPRO", "logs");
                            foreach (string name in new string[] { "v3160-yazici-startup.log", "v3160-webservice.err.log", "v3160-revenue.err.log" })
                            {
                                string log = Path.Combine(logDir, name);
                                if (!File.Exists(log)) continue;
                                string[] lines = File.ReadAllLines(log);
                                int take = Math.Min(5, lines.Length);
                                string tail = take > 0 ? string.Join(" | ", lines, lines.Length - take, take) : string.Empty;
                                if (!string.IsNullOrWhiteSpace(tail)) detail += (detail.Length > 0 ? "\n" : "") + name + ": " + tail;
                            }
                            if (hostProcess.HasExited) detail += (detail.Length > 0 ? "\n" : "") + "Başlatıcı çıkış kodu: " + hostProcess.ExitCode.ToString();
                        }
                        catch { }
                        throw new InvalidOperationException("Yazıcı PRO servisleri 150 saniye içinde hazır olmadı." + (string.IsNullOrWhiteSpace(detail) ? "" : "\n" + detail));
                    }
                    try { hostProcess.Dispose(); } catch { }
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

        private async void ClientProButton_Click(object sender, EventArgs e)
        {
            try
            {
                clientProButton.Enabled = false;
                clientProButton.Text = "🖥 Client Açılıyor...";
                if (!await IsClientProReadyAsync())
                {
                    string service = Path.Combine(ClientProRoot, "web_service.py");
                    if (!File.Exists(service)) throw new InvalidOperationException("Client Yönetim PRO dosyaları bulunamadı: " + ClientProRoot);
                    ProcessStartInfo psi = new ProcessStartInfo("py.exe", "-3 -B \"" + service + "\"");
                    psi.WorkingDirectory = ClientProRoot;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                    for (int i = 0; i < 40 && !await IsClientProReadyAsync(); i++) await Task.Delay(500);
                    if (!await IsClientProReadyAsync()) throw new InvalidOperationException("Client Yönetim PRO servisi başlatılamadı.");
                }
                await EnsureClientBrowserAsync();
                ShowClientView();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Client Yönetim PRO açılamadı:\n" + ex.Message, "Client Yönetim PRO", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                clientProButton.Text = "🖥 Client Yönetim PRO";
                clientProButton.Enabled = true;
            }
        }

        private async Task<bool> IsClientProReadyAsync()
        {
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ClientProUrl + "api/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    req.Timeout = 1200; req.ReadWriteTimeout = 1200;
                    using (HttpWebResponse response = (HttpWebResponse)req.GetResponse())
                    {
                        return (int)response.StatusCode == 200 && string.Equals(response.Headers["X-KafePin-Client-Isolation"], "separate-loopback-service", StringComparison.OrdinalIgnoreCase);
                    }
                }
                catch { return false; }
            });
        }

        private async Task EnsureClientBrowserAsync()
        {
            if (clientBrowserReady && clientBrowser.CoreWebView2 != null) return;
            CoreWebView2Environment env = await GetSharedWebViewEnvironmentAsync();
            await clientBrowser.EnsureCoreWebView2Async(env);
            clientBrowser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            clientBrowser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            clientBrowser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            clientBrowser.CoreWebView2.Settings.IsZoomControlEnabled = false;
            await EnableWebContentOutsideClickDismissAsync(clientBrowser);
            clientBrowser.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e) { if (!IsClientProUrl(e.Uri)) { e.Cancel = true; OpenExternal(e.Uri); } };
            clientBrowser.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e) { clientBrowserReady = e.IsSuccess; };
            clientBrowser.CoreWebView2.ProcessFailed += delegate { clientBrowserReady = false; };
            clientBrowser.Source = new Uri(WithCacheBust(ClientProUrl));
            for (int i = 0; i < 100 && !clientBrowserReady; i++) await Task.Delay(100);
            if (!clientBrowserReady) throw new InvalidOperationException("Client Yönetim PRO paneli WebView2 içinde yüklenemedi.");
        }

        private void ShowClientView()
        {
            mp3ViewActive = false; printerViewActive = false; serviceViewActive = false; clientViewActive = true;
            splash.Visible = false; browser.Visible = false; mp3Browser.Visible = false; printerBrowser.Visible = false; serviceBrowser.Visible = false;
            clientBrowser.Visible = true; clientBrowser.BringToFront(); UpdateNavButtons(ClientProUrl);
            KeepWhatsAppSidebarOnTop();
        }

        private static bool IsClientProUrl(string value)
        {
            Uri uri; if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
            return (uri.Scheme == "http" || uri.Scheme == "https") && (string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase) || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)) && uri.Port == 17894;
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

        private Task<CoreWebView2Environment> GetWhatsAppPersonalEnvironmentAsync()
        {
            if (whatsAppPersonalEnvironmentTask == null)
            {
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "KafePinPro", "WebView2-WhatsApp-Personal");
                Directory.CreateDirectory(userData);
                whatsAppPersonalEnvironmentTask = CoreWebView2Environment.CreateAsync(null, userData);
            }
            return whatsAppPersonalEnvironmentTask;
        }

        private Task<CoreWebView2Environment> GetTelegramEnvironmentAsync()
        {
            if (telegramEnvironmentTask == null)
            {
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "KafePinPro", "WebView2-Telegram");
                Directory.CreateDirectory(userData);
                telegramEnvironmentTask = CoreWebView2Environment.CreateAsync(null, userData);
            }
            return telegramEnvironmentTask;
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
                await EnableWebContentOutsideClickDismissAsync(mp3Browser);
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
            serviceViewActive = false;
            clientViewActive = false;
            splash.Visible = false;
            browser.Visible = false;
            printerBrowser.Visible = false;
            serviceBrowser.Visible = false;
            clientBrowser.Visible = false;
            mp3Browser.Visible = true;
            mp3Browser.BringToFront();
            UpdateNavButtons(Mp3BotUrl);
            KeepWhatsAppSidebarOnTop();
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
                    KeepWhatsAppSidebarOnTop();
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
            await EnableWebContentOutsideClickDismissAsync(serviceBrowser);
            serviceBrowser.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e){ if(!IsServiceProUrl(e.Uri)){e.Cancel=true;OpenExternal(e.Uri);} };
            serviceBrowser.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e){serviceBrowserReady=e.IsSuccess;};
            serviceBrowser.Source=new Uri(WithCacheBust(ServiceProUrl));
            for(int i=0;i<100&&!serviceBrowserReady;i++) await Task.Delay(100);
            if(!serviceBrowserReady) throw new InvalidOperationException("Teknik Servis PRO paneli WebView2 içinde yüklenemedi.");
        }

        private void ShowServiceView()
        {
            mp3ViewActive=false; printerViewActive=false; serviceViewActive=true; clientViewActive=false; splash.Visible=false; browser.Visible=false; mp3Browser.Visible=false; printerBrowser.Visible=false; clientBrowser.Visible=false; serviceBrowser.Visible=true; serviceBrowser.BringToFront(); UpdateNavButtons(ServiceProUrl); KeepWhatsAppSidebarOnTop();
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
                await EnableWebContentOutsideClickDismissAsync(printerBrowser);
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
            serviceViewActive = false;
            clientViewActive = false;
            splash.Visible = false;
            browser.Visible = false;
            mp3Browser.Visible = false;
            serviceBrowser.Visible = false;
            clientBrowser.Visible = false;
            printerBrowser.Visible = true;
            printerBrowser.BringToFront();
            UpdateNavButtons(PrinterProUrl);
            KeepWhatsAppSidebarOnTop();
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
            if (whatsAppBrowserInitializing)
            {
                for (int i=0; i<200 && whatsAppBrowserInitializing; i++) await Task.Delay(100);
                if (whatsAppBrowserReady && whatsAppBrowser.CoreWebView2 != null) return;
            }
            whatsAppBrowserInitializing = true;
            try
            {
            CoreWebView2Environment env = await GetSharedWebViewEnvironmentAsync();
            await whatsAppBrowser.EnsureCoreWebView2Async(env);
            whatsAppBrowser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            whatsAppBrowser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            whatsAppBrowser.CoreWebView2.Settings.IsZoomControlEnabled = true;
            EnableMessagingNotifications(whatsAppBrowser, "business", "WhatsApp Business");
            whatsAppBrowser.CoreWebView2.DocumentTitleChanged += delegate
            {
                try { UpdateWhatsAppBadge(false, whatsAppBrowser.CoreWebView2.DocumentTitle); } catch { }
            };
            whatsAppBrowser.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try { if (!string.IsNullOrWhiteSpace(e.Uri)) whatsAppBrowser.CoreWebView2.Navigate(e.Uri); } catch { }
            };
            whatsAppBrowser.NavigationCompleted += async delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                whatsAppBrowserReady = e.IsSuccess;
                if (e.IsSuccess) await ApplyWhatsAppNavigationOffsetAsync(whatsAppBrowser);
            };
            whatsAppBrowser.CoreWebView2.ProcessFailed += delegate { whatsAppBrowserReady = false; };
            whatsAppBrowser.Source = new Uri(WhatsAppUrl);
            for (int i=0; i<200 && !whatsAppBrowserReady; i++) await Task.Delay(100);
            if (!whatsAppBrowserReady) throw new InvalidOperationException("WhatsApp Web, KafePin içindeki WebView2'de yüklenemedi.");
            }
            finally { whatsAppBrowserInitializing = false; }
        }

        private async Task EnsureWhatsAppPersonalBrowserAsync()
        {
            if (whatsAppPersonalBrowserReady && whatsAppPersonalBrowser.CoreWebView2 != null) return;
            if (whatsAppPersonalBrowserInitializing)
            {
                for (int i=0; i<200 && whatsAppPersonalBrowserInitializing; i++) await Task.Delay(100);
                if (whatsAppPersonalBrowserReady && whatsAppPersonalBrowser.CoreWebView2 != null) return;
            }
            whatsAppPersonalBrowserInitializing = true;
            try
            {
            CoreWebView2Environment env = await GetWhatsAppPersonalEnvironmentAsync();
            await whatsAppPersonalBrowser.EnsureCoreWebView2Async(env);
            whatsAppPersonalBrowser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            whatsAppPersonalBrowser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            whatsAppPersonalBrowser.CoreWebView2.Settings.IsZoomControlEnabled = true;
            EnableMessagingNotifications(whatsAppPersonalBrowser, "personal", "WhatsApp Kişisel");
            whatsAppPersonalBrowser.CoreWebView2.DocumentTitleChanged += delegate
            {
                try { UpdateWhatsAppBadge(true, whatsAppPersonalBrowser.CoreWebView2.DocumentTitle); } catch { }
            };
            whatsAppPersonalBrowser.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try { if (!string.IsNullOrWhiteSpace(e.Uri)) whatsAppPersonalBrowser.CoreWebView2.Navigate(e.Uri); } catch { }
            };
            whatsAppPersonalBrowser.NavigationCompleted += async delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                whatsAppPersonalBrowserReady = e.IsSuccess;
                if (e.IsSuccess) await ApplyWhatsAppNavigationOffsetAsync(whatsAppPersonalBrowser);
            };
            whatsAppPersonalBrowser.CoreWebView2.ProcessFailed += delegate { whatsAppPersonalBrowserReady = false; };
            whatsAppPersonalBrowser.Source = new Uri(WhatsAppUrl);
            for (int i=0; i<200 && !whatsAppPersonalBrowserReady; i++) await Task.Delay(100);
            if (!whatsAppPersonalBrowserReady) throw new InvalidOperationException("Kişisel WhatsApp Web yüklenemedi.");
            }
            finally { whatsAppPersonalBrowserInitializing = false; }
        }

        private async Task EnsureTelegramBrowserAsync()
        {
            if (telegramBrowserReady && telegramBrowser.CoreWebView2 != null) return;
            if (telegramBrowserInitializing)
            {
                for (int i=0; i<200 && telegramBrowserInitializing; i++) await Task.Delay(100);
                if (telegramBrowserReady && telegramBrowser.CoreWebView2 != null) return;
            }
            telegramBrowserInitializing = true;
            try
            {
            CoreWebView2Environment env = await GetTelegramEnvironmentAsync();
            await telegramBrowser.EnsureCoreWebView2Async(env);
            telegramBrowser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            telegramBrowser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            telegramBrowser.CoreWebView2.Settings.IsZoomControlEnabled = true;
            EnableMessagingNotifications(telegramBrowser, "telegram", "Telegram");
            if (!File.Exists(telegramCacheRepairMarkerPath))
            {
                await ClearTelegramUpdateCacheAsync();
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(telegramCacheRepairMarkerPath));
                    File.WriteAllText(telegramCacheRepairMarkerPath, DateTime.UtcNow.ToString("o"));
                }
                catch { }
            }
            telegramBrowser.CoreWebView2.DocumentTitleChanged += delegate
            {
                try { UpdateTelegramBadge(telegramBrowser.CoreWebView2.DocumentTitle); } catch { }
            };
            telegramBrowser.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try { if (!string.IsNullOrWhiteSpace(e.Uri)) telegramBrowser.CoreWebView2.Navigate(e.Uri); } catch { }
            };
            telegramBrowser.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                telegramBrowserReady = e.IsSuccess;
            };
            telegramBrowser.CoreWebView2.ProcessFailed += delegate { telegramBrowserReady = false; };
            telegramBrowser.Source = new Uri(TelegramWebUrl);
            for (int i=0; i<200 && !telegramBrowserReady; i++) await Task.Delay(100);
            if (!telegramBrowserReady) throw new InvalidOperationException("Telegram Web yüklenemedi.");
            }
            finally { telegramBrowserInitializing = false; }
        }

        private void EnableMessagingNotifications(WebView2 view, string target, string sourceLabel)
        {
            try
            {
                view.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e)
                {
                    if (e.PermissionKind != CoreWebView2PermissionKind.Notifications) return;
                    e.State = CoreWebView2PermissionState.Allow;
                    e.Handled = true;
                };
                view.CoreWebView2.NotificationReceived += delegate(object sender, CoreWebView2NotificationReceivedEventArgs e)
                {
                    try
                    {
                        e.Handled = true;
                        CoreWebView2Notification notification = e.Notification;
                        if (IsHandleCreated)
                            BeginInvoke((Action)delegate { ShowMessagingNotification(target, sourceLabel, notification); });
                    }
                    catch { }
                };
            }
            catch { }
        }

        private async Task WarmMessagingBrowsersAsync()
        {
            await Task.Delay(1200);
            try { await EnsureWhatsAppBrowserAsync(); } catch { }
            try { await EnsureWhatsAppPersonalBrowserAsync(); } catch { }
            try { await EnsureTelegramBrowserAsync(); } catch { }
        }

        private async Task ReloadActiveMessagingViewAsync()
        {
            try
            {
                messagingRefreshButton.Enabled = false;
                messagingRefreshButton.Text = "…";
                WebView2 target;
                if (telegramActive)
                {
                    await EnsureTelegramBrowserAsync();
                    target = telegramBrowser;
                    await ClearTelegramUpdateCacheAsync();
                    telegramBrowserReady = false;
                    target.CoreWebView2.Navigate(TelegramWebUrl + "?_kpreload=" + DateTime.UtcNow.Ticks.ToString());
                    return;
                }
                else if (whatsAppPersonalActive) { await EnsureWhatsAppPersonalBrowserAsync(); target = whatsAppPersonalBrowser; }
                else { await EnsureWhatsAppBrowserAsync(); target = whatsAppBrowser; }
                if (target.CoreWebView2 != null) target.CoreWebView2.Reload();
            }
            catch { }
            finally
            {
                messagingRefreshButton.Text = "↻";
                messagingRefreshButton.Enabled = true;
            }
        }

        private async Task ClearTelegramUpdateCacheAsync()
        {
            if (telegramBrowser == null || telegramBrowser.CoreWebView2 == null) return;
            CoreWebView2BrowsingDataKinds kinds =
                CoreWebView2BrowsingDataKinds.DiskCache |
                CoreWebView2BrowsingDataKinds.CacheStorage |
                CoreWebView2BrowsingDataKinds.ServiceWorkers;
            await telegramBrowser.CoreWebView2.Profile.ClearBrowsingDataAsync(kinds);
        }

        private async Task ApplyWhatsAppNavigationOffsetAsync(WebView2 view)
        {
            try
            {
                if (view == null || view.CoreWebView2 == null) return;
                await view.CoreWebView2.ExecuteScriptAsync(
                    "(function(){" +
                    "if(window.__kpWaRailOffset)return;window.__kpWaRailOffset=true;" +
                    "function apply(){var a=[].slice.call(document.querySelectorAll('nav,[role=\"navigation\"]'));" +
                    "var n=a.find(function(e){var r=e.getBoundingClientRect();return r.left<24&&r.width>35&&r.width<105&&r.height>window.innerHeight*.55;});" +
                    "if(n){n.style.setProperty('padding-top','18px','important');n.style.setProperty('box-sizing','border-box','important');}}" +
                    "apply();new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true});" +
                    "window.addEventListener('resize',apply);})()"
                );
            }
            catch { }
        }

        private void ShowWhatsAppView()
        {
            ClearMessagingNotification("business");
            whatsAppViewActive = true;
            whatsAppPersonalActive = false;
            telegramActive = false;
            whatsAppPersonalBrowser.Visible = false;
            telegramBrowser.Visible = false;
            whatsAppBrowser.Visible = true;
            whatsAppSidebarToggleButton.Visible = false;
            SetActive(whatsAppTopButton, true);
            SetActive(whatsAppPersonalTopButton, false);
            SetActive(telegramTopButton, false);
            try { UpdateWhatsAppBadge(false, whatsAppBrowser.CoreWebView2 == null ? "" : whatsAppBrowser.CoreWebView2.DocumentTitle); } catch { }
            KeepWhatsAppSidebarOnTop();
        }

        private void ShowWhatsAppPersonalView()
        {
            ClearMessagingNotification("personal");
            whatsAppViewActive = true;
            whatsAppPersonalActive = true;
            telegramActive = false;
            whatsAppBrowser.Visible = false;
            telegramBrowser.Visible = false;
            whatsAppPersonalBrowser.Visible = true;
            whatsAppSidebarToggleButton.Visible = false;
            SetActive(whatsAppTopButton, false);
            SetActive(whatsAppPersonalTopButton, true);
            SetActive(telegramTopButton, false);
            try { UpdateWhatsAppBadge(true, whatsAppPersonalBrowser.CoreWebView2 == null ? "" : whatsAppPersonalBrowser.CoreWebView2.DocumentTitle); } catch { }
            KeepWhatsAppSidebarOnTop();
        }

        private void ShowTelegramView()
        {
            ClearMessagingNotification("telegram");
            whatsAppViewActive = true;
            whatsAppPersonalActive = false;
            telegramActive = true;
            whatsAppBrowser.Visible = false;
            whatsAppPersonalBrowser.Visible = false;
            telegramBrowser.Visible = true;
            whatsAppSidebarToggleButton.Visible = false;
            SetActive(whatsAppTopButton, false);
            SetActive(whatsAppPersonalTopButton, false);
            SetActive(telegramTopButton, true);
            try { UpdateTelegramBadge(telegramBrowser.CoreWebView2 == null ? "" : telegramBrowser.CoreWebView2.DocumentTitle); } catch { }
            KeepWhatsAppSidebarOnTop();
        }

        private void CloseWhatsAppPanel()
        {
            whatsAppViewActive = false;
            whatsAppPanel.Visible = false;
            LayoutWhatsAppPanel();
            whatsAppSidebarToggleButton.Visible = false;
            SetActive(whatsAppTopButton, false);
            SetActive(whatsAppPersonalTopButton, false);
            SetActive(telegramTopButton, false);
        }

        private void CloseMessagingPanelOnOutsideClick()
        {
            if (!whatsAppViewActive || !whatsAppPanel.Visible || whatsAppPanelResizing) return;
            Point cursor = Cursor.Position;
            if (whatsAppPanel.RectangleToScreen(whatsAppPanel.ClientRectangle).Contains(cursor)) return;

            // Üstteki üç mesaj düğmesi kendi aç/kapat ve panel değiştirme
            // davranışını yönetir; dış tıklama filtresi bunlara karışmaz.
            Control[] toggles = { whatsAppTopButton, whatsAppPersonalTopButton, telegramTopButton,
                                  whatsAppBusinessBadge, whatsAppPersonalBadge, telegramBadge };
            foreach (Control toggle in toggles)
            {
                if (toggle != null && toggle.Visible && toggle.RectangleToScreen(toggle.ClientRectangle).Contains(cursor)) return;
            }
            CloseWhatsAppPanel();
        }

        private async Task EnableWebContentOutsideClickDismissAsync(WebView2 view)
        {
            if (view == null || view.CoreWebView2 == null) return;
            view.CoreWebView2.Settings.IsWebMessageEnabled = true;
            view.CoreWebView2.WebMessageReceived += ContentCoreWebView2_WebMessageReceived;
            const string script =
                "(function(){" +
                "if(window.__kafePinOutsideMessagingDismiss)return;" +
                "window.__kafePinOutsideMessagingDismiss=true;" +
                "document.addEventListener('pointerdown',function(){" +
                "try{window.chrome.webview.postMessage('close-messaging-panel');}catch(e){}" +
                "},true);" +
                "})()";
            await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script);
            try { await view.CoreWebView2.ExecuteScriptAsync(script); } catch { }
        }

        private void ContentCoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                if (!string.Equals(e.TryGetWebMessageAsString(), "close-messaging-panel", StringComparison.Ordinal)) return;
                if (whatsAppViewActive) CloseWhatsAppPanel();
            }
            catch { }
        }

        private void KeepWhatsAppSidebarOnTop()
        {
            if (!whatsAppViewActive)
            {
                whatsAppSidebarToggleButton.Visible = false;
                return;
            }
            whatsAppSidebarToggleButton.Visible = false;
            whatsAppBrowser.Visible = !whatsAppPersonalActive && !telegramActive;
            whatsAppPersonalBrowser.Visible = whatsAppPersonalActive && !telegramActive;
            telegramBrowser.Visible = telegramActive;
            if (telegramActive) telegramBrowser.BringToFront();
            else if (whatsAppPersonalActive) whatsAppPersonalBrowser.BringToFront();
            else whatsAppBrowser.BringToFront();
            messagingRefreshButton.BringToFront();
            whatsAppResizeGrip.BringToFront();
            LayoutWhatsAppPanel();
            whatsAppPanel.Visible = true;
            whatsAppPanel.BringToFront();
        }

        private void LayoutWhatsAppSidebarToggle()
        {
            if (whatsAppSidebarToggleButton == null) return;
            whatsAppSidebarToggleButton.Left = 0;
            whatsAppSidebarToggleButton.Top = Math.Max(18, ClientSize.Height / 2 - whatsAppSidebarToggleButton.Height / 2);
        }

        private void LayoutWhatsAppPanel()
        {
            if (whatsAppPanel == null || appShellPanel == null) return;
            int hostWidth = Math.Max(900, ClientSize.Width);
            int shellReserve = hostWidth >= 1500 ? 720 : Math.Max(360, hostWidth - 828);
            int availableForWhatsApp = Math.Max(600, hostWidth - shellReserve);
            int minWidth = Math.Min(900, availableForWhatsApp);
            int maxWidth = Math.Max(minWidth, Math.Min(1700, availableForWhatsApp));
            int automaticWidth = maxWidth;
            int width = whatsAppPanelUserSized
                ? Math.Max(minWidth, Math.Min(whatsAppPanel.Width, maxWidth))
                : automaticWidth;
            int shellLeft = whatsAppViewActive ? width : 0;
            appShellPanel.SetBounds(shellLeft, 0, Math.Max(1, ClientSize.Width - shellLeft), ClientSize.Height);
            whatsAppPanel.SetBounds(0, 0, width, ClientSize.Height);
            if (messagingRefreshButton != null)
                messagingRefreshButton.Location = new Point(Math.Max(8, width - messagingRefreshButton.Width - whatsAppResizeGrip.Width - 10), 10);
            ApplyWhatsAppResponsiveZoom(width);
        }

        private void ApplyWhatsAppResponsiveZoom(int panelWidth)
        {
            try
            {
                double zoom = panelWidth < 680 ? 0.80 : panelWidth < 820 ? 0.90 : 1.0;
                if (Math.Abs(whatsAppBrowser.ZoomFactor - zoom) > 0.01)
                    whatsAppBrowser.ZoomFactor = zoom;
                if (Math.Abs(whatsAppPersonalBrowser.ZoomFactor - zoom) > 0.01)
                    whatsAppPersonalBrowser.ZoomFactor = zoom;
                if (Math.Abs(telegramBrowser.ZoomFactor - zoom) > 0.01)
                    telegramBrowser.ZoomFactor = zoom;
            }
            catch { }
        }

        private void LoadWhatsAppSidebarWidth()
        {
            try
            {
                if (!File.Exists(whatsAppSidebarSettingsPath)) return;
                string value = File.ReadAllText(whatsAppSidebarSettingsPath).Trim();
                int width;
                if (int.TryParse(value, out width) && width >= 600 && width <= 1180)
                {
                    whatsAppPanel.Width = width;
                    whatsAppPanelUserSized = true;
                }
            }
            catch { }
        }

        private void SaveWhatsAppSidebarWidth()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(whatsAppSidebarSettingsPath));
                File.WriteAllText(
                    whatsAppSidebarSettingsPath,
                    whatsAppPanelUserSized ? whatsAppPanel.Width.ToString() : "auto");
            }
            catch { }
        }

        private void WhatsAppResizeGrip_MouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            whatsAppPanelResizing = true;
            whatsAppResizeStartX = Cursor.Position.X;
            whatsAppResizeStartWidth = whatsAppPanel.Width;
            whatsAppResizeGrip.Capture = true;
        }

        private void WhatsAppResizeGrip_MouseMove(object sender, MouseEventArgs e)
        {
            if (!whatsAppPanelResizing) return;
            int wanted = whatsAppResizeStartWidth + Cursor.Position.X - whatsAppResizeStartX;
            int hostWidth = Math.Max(900, ClientSize.Width);
            int shellReserve = hostWidth >= 1500 ? 720 : Math.Max(360, hostWidth - 828);
            int availableForWhatsApp = Math.Max(600, hostWidth - shellReserve);
            int minWidth = Math.Min(900, availableForWhatsApp);
            int maxWidth = Math.Max(minWidth, Math.Min(1700, availableForWhatsApp));
            whatsAppPanelUserSized = true;
            whatsAppPanel.Width = Math.Max(minWidth, Math.Min(wanted, maxWidth));
            appShellPanel.SetBounds(whatsAppPanel.Width, 0, Math.Max(1, ClientSize.Width - whatsAppPanel.Width), ClientSize.Height);
            ApplyWhatsAppResponsiveZoom(whatsAppPanel.Width);
        }

        private void WhatsAppResizeGrip_MouseUp(object sender, MouseEventArgs e)
        {
            whatsAppPanelResizing = false;
            whatsAppResizeGrip.Capture = false;
            if (whatsAppPanelUserSized) SaveWhatsAppSidebarWidth();
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
                    if (whatsAppViewActive && whatsAppPanel.Visible)
                        whatsAppPanel.BringToFront();
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
                    req.Method = "GET"; req.Timeout = 1500; req.ReadWriteTimeout = 1500;
                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (StreamReader rd = new StreamReader(resp.GetResponseStream()))
                    {
                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return false;
                        string isolation = resp.Headers["X-KafePin-Yazici-Isolation"] ?? string.Empty;
                        if (!string.Equals(isolation, "separate-loopback-service", StringComparison.OrdinalIgnoreCase)) return false;
                        string health = rd.ReadToEnd();
                        // Yazici PRO paket surumu 3.1.60'a sabitlenmez; servis kimligi
                        // ve version alani dogrulanir. Boylece 3.1.61+ servisleri
                        // saglikli olduklari halde yanlislikla basarisiz sayilmaz.
                        // JSON Turkce karakterleri Unicode escape olarak dondurebilir;
                        // servis kimligini aksanli metinle degil alanlarla dogrula.
                        if (health.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) < 0 ||
                            health.IndexOf("\"service\":", StringComparison.OrdinalIgnoreCase) < 0 ||
                            health.IndexOf("\"version\":", StringComparison.OrdinalIgnoreCase) < 0) return false;
                    }
                    HttpWebRequest rev = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:17893/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    rev.Method = "GET"; rev.Timeout = 1500; rev.ReadWriteTimeout = 1500;
                    using (HttpWebResponse resp = (HttpWebResponse)rev.GetResponse())
                    using (StreamReader rd = new StreamReader(resp.GetResponseStream()))
                    {
                        string health = rd.ReadToEnd();
                        return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300 &&
                            health.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0 &&
                            health.IndexOf("\"service\":", StringComparison.OrdinalIgnoreCase) >= 0 &&
                            health.IndexOf("\"version\"", StringComparison.OrdinalIgnoreCase) >= 0;
                    }
                }
                catch { return false; }
            });
        }

        private async Task<bool> WaitForPrinterProAsync(int maxSeconds)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, maxSeconds));
            while (DateTime.UtcNow < deadline)
            {
                if (await IsPrinterProReadyOnceAsync()) return true;
                int remainingMs = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
                if (remainingMs <= 0) break;
                await Task.Delay(Math.Min(500, remainingMs));
            }
            return await IsPrinterProReadyOnceAsync();
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
            serviceViewActive = false;
            clientViewActive = false;
            targetUrl = url;
            UpdateNavButtons(url);
            splash.Visible = false;
            mp3Browser.Visible = false;
            printerBrowser.Visible = false;
            serviceBrowser.Visible = false;
            clientBrowser.Visible = false;
            browser.Visible = true;
            browser.BringToFront();
            KeepWhatsAppSidebarOnTop();
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
                    await EnableWebContentOutsideClickDismissAsync(browser);

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

        private async void Browser_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                browser.Visible = true;
                if (!IsEmbeddedToolViewActive())
                {
                    splash.Visible = false;
                    browser.BringToFront();
                    try { UpdateNavButtons(browser.Source != null ? browser.Source.ToString() : targetUrl); } catch { }
                    KeepWhatsAppSidebarOnTop();
                }
                await ApplyEveryCafeAdminVisibilityAsync();
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

        private async Task ApplyEveryCafeAdminVisibilityAsync()
        {
            if (IsEveryCafeEnabledForThisCafe() || browser.CoreWebView2 == null) return;
            string current = browser.Source != null ? browser.Source.ToString() : targetUrl;
            if (current.IndexOf("/admin.html", StringComparison.OrdinalIgnoreCase) < 0) return;
            const string script = @"(() => {
  const apply = () => {
    const panelButton = document.querySelector('#adminPanelSwitcher [data-panel=""everycafe""]');
    if (panelButton) panelButton.style.display = 'none';
    const switcher = document.getElementById('adminPanelSwitcher');
    if (switcher) switcher.style.gridTemplateColumns = 'repeat(3,minmax(0,1fr))';
    const quickLink = document.querySelector('#adminQuickNav a[href=""#section-everycafe""]');
    if (quickLink) quickLink.style.display = 'none';
    let section = document.getElementById('section-everycafe');
    if (!section) {
      section = Array.from(document.querySelectorAll('.card')).find(card => {
        const heading = card.querySelector(':scope > h2');
        return heading && heading.textContent.includes('EveryCafe Entegrasyon');
      });
    }
    if (section) section.style.display = 'none';
    const inlinePanel = document.getElementById('everyCafeInlinePanel');
    if (inlinePanel) inlinePanel.style.display = 'none';
    if (document.body && document.body.dataset.adminPanel === 'everycafe' && typeof window.setAdminPanel === 'function') {
      window.setAdminPanel('cafe', false);
    }
  };
  apply();
  let remaining = 20;
  const timer = window.setInterval(() => { apply(); if (--remaining <= 0) window.clearInterval(timer); }, 250);
})();";
            try { await browser.CoreWebView2.ExecuteScriptAsync(script); } catch { }
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
            return mp3ViewActive || printerViewActive || serviceViewActive || clientViewActive;
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
