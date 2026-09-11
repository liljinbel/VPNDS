using System;
using System.IO;
using System.Xml;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Net;
using System.Net.NetworkInformation;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Markup;

namespace DnsVpnApp {
    public class DnsProvider {
        public string Key { get; set; }
        public string Name { get; set; }
        public string Primary { get; set; }
        public string Secondary { get; set; }
        public string Ipv6Primary { get; set; }
        public string Ipv6Secondary { get; set; }
        public string Desc { get; set; }
        public string Badge { get; set; }
        public string ColorHex { get; set; }
        public string IconPathData { get; set; }

        public Border CardBorder { get; set; }
        public Button ActionButton { get; set; }
        public Border ActionBorder { get; set; }
        public TextBlock ActionText { get; set; }
        public TextBlock PingTextBlock { get; set; }
        public Border StatusInUseBadge { get; set; }
    }

    public class UpdateInfo {
        public string Version { get; set; }
        public string ReleaseDate { get; set; }
        public string Title { get; set; }
        public string Changelog { get; set; }
        public string DownloadUrl { get; set; }
        public string PackageUrl { get; set; }
    }

    public class Program {
        public const string CURRENT_VERSION = "1.2.0";
        private const string UPDATE_CHECK_URL = "https://raw.githubusercontent.com/liljinbel/VPNDS/main/version.json";

        private static Window _window;
        private static Border _updateCard;
        private static TextBlock _txtUpdateVersion;
        private static TextBlock _txtUpdateDesc;
        private static TextBlock _txtUpdateProgress;
        private static Button _btnChangelog;
        private static Button _btnApplyUpdate;
        private static TextBlock _txtBtnApply;
        private static Border _borderBtnApply;
        private static Button _btnCheckUpdate;
        private static UpdateInfo _latestUpdate = null;
        private static bool _isUpdating = false;

        private static Border _statusCard;
        private static System.Windows.Shapes.Ellipse _statusDot;
        private static TextBlock _statusTitle;
        private static TextBlock _statusValue;
        private static TextBlock _statusAdapter;
        private static Border _statusBadge;
        private static TextBlock _statusBadgeText;

        private static Border _badgeVpnStatus;
        private static TextBlock _txtVpnStatus;
        private static Button _btnToggleVpn;
        private static TextBlock _txtBtnVpn;
        private static Border _borderVpn;

        private static Border _badgeDiscordStatus;
        private static TextBlock _txtDiscordStatus;
        private static Button _btnToggleDiscord;
        private static Button _btnRestartDiscord;
        private static TextBlock _txtBtnDiscord;
        private static Border _borderDiscord;
        private static bool _discordInstalled = false;

        private static Button _btnRestoreMaster;
        private static TextBlock _lblMasterOrig;
        private static Button _btnResetIp;
        private static Button _btnPingAll;
        private static StackPanel _cardsPanel;
        private static TextBox _txtOriginalDns;
        private static TextBlock _txtStatusLog;

        private static string _originalDns = "192.168.0.113";
        private static string _configFile = "config.json";
        private static List<DnsProvider> _providers = new List<DnsProvider>();
        private static BrushConverter _bc = new BrushConverter();

        [STAThread]
        public static void Main() {
            try {
                AppDomain.CurrentDomain.UnhandledException += (s, e) => {
                    MessageBox.Show("Erro inesperado: " + e.ExceptionObject.ToString(), "Erro", MessageBoxButton.OK, MessageBoxImage.Error);
                };

                string appDir = AppDomain.CurrentDomain.BaseDirectory;
                _configFile = Path.Combine(appDir, "config.json");
                LoadConfig();

                InitProviders();
                BuildAndShowGui();
            } catch (Exception ex) {
                MessageBox.Show("Erro ao inicializar o Painel de DNS:\n" + ex.Message, "Erro Crítico", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private static void LoadConfig() {
            try {
                if (File.Exists(_configFile)) {
                    string content = File.ReadAllText(_configFile);
                    int idx = content.IndexOf("\"primary\"");
                    if (idx != -1) {
                        int colon = content.IndexOf(":", idx);
                        int quote1 = content.IndexOf("\"", colon);
                        int quote2 = content.IndexOf("\"", quote1 + 1);
                        if (quote1 != -1 && quote2 != -1) {
                            string val = content.Substring(quote1 + 1, quote2 - quote1 - 1).Trim();
                            if (!string.IsNullOrEmpty(val)) {
                                _originalDns = val;
                                return;
                            }
                        }
                    }
                }

                List<string> current = GetCurrentDnsAddresses();
                if (current != null && current.Count > 0 && !string.IsNullOrEmpty(current[0])) {
                    _originalDns = current[0];
                }
            } catch { }
        }

        private static void SaveConfig() {
            try {
                string json = "{\n  \"originalDns\": {\n    \"primary\": \"" + _originalDns + "\",\n    \"secondary\": \"\"\n  }\n}";
                File.WriteAllText(_configFile, json);
            } catch { }
        }

        private static void InitProviders() {
            // 1. CLOUDFLARE (Nuvem oficial Cloudflare)
            _providers.Add(new DnsProvider {
                Key = "Cloudflare",
                Name = "Cloudflare DNS",
                Primary = "1.1.1.1",
                Secondary = "1.0.0.1",
                Ipv6Primary = "2606:4700:4700::1111",
                Ipv6Secondary = "2606:4700:4700::1001",
                Desc = "Velocidade ultra-rapida e privacidade total sem filtros.",
                Badge = "Ultra Rapido",
                ColorHex = "#FFFFFF",
                IconPathData = "M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"
            });

            // 2. GOOGLE (G oficial Google)
            _providers.Add(new DnsProvider {
                Key = "Google",
                Name = "Google Public DNS",
                Primary = "8.8.8.8",
                Secondary = "8.8.4.4",
                Ipv6Primary = "2001:4860:4860::8888",
                Ipv6Secondary = "2001:4860:4860::8844",
                Desc = "Infraestrutura global massiva e alta estabilidade de rede.",
                Badge = "Mais Estavel",
                ColorHex = "#E4E4E7",
                IconPathData = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c5.52 0 10-4.48 10-10 0-.68-.07-1.35-.2-2H12v4h5.65c-.56 2.3-2.5 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78l2.83-2.83C17.27 3.54 14.77 2 12 2z"
            });

            // 3. QUAD9 (Escudo de Seguranca com Cadeado)
            _providers.Add(new DnsProvider {
                Key = "Quad9",
                Name = "Quad9 Security",
                Primary = "9.9.9.9",
                Secondary = "149.112.112.112",
                Ipv6Primary = "2620:fe::fe",
                Ipv6Secondary = "2620:fe::9",
                Desc = "Protecao automatica e bloqueio de ameacas e malware.",
                Badge = "Seguranca",
                ColorHex = "#D4D4D8",
                IconPathData = "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 6c1.66 0 3 1.34 3 3v2h1v6H8v-6h1v-2c0-1.66 1.34-3 3-3zm-1 5h2v-2c0-.55-.45-1-1-1s-1 .45-1 1v2z"
            });

            // 4. OPENDNS / CISCO (Globo de Conectividade)
            _providers.Add(new DnsProvider {
                Key = "OpenDNS",
                Name = "OpenDNS (Cisco)",
                Primary = "208.67.222.222",
                Secondary = "208.67.220.220",
                Ipv6Primary = "2620:119:35::35",
                Ipv6Secondary = "2620:119:53::53",
                Desc = "Filtro confiavel e protecao corporativa contra phishing.",
                Badge = "Familiar",
                ColorHex = "#A1A1AA",
                IconPathData = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
            });

            // 5. ADGUARD (Escudo com Checkmark de Bloqueio de Ads)
            _providers.Add(new DnsProvider {
                Key = "AdGuard",
                Name = "AdGuard DNS",
                Primary = "94.140.14.14",
                Secondary = "94.140.15.15",
                Ipv6Primary = "2a10:50c0::ad1:ff",
                Ipv6Secondary = "2a10:50c0::ad2:ff",
                Desc = "Bloqueia anuncios e rastreadores invasivos na web.",
                Badge = "Sem Ads",
                ColorHex = "#A1A1AA",
                IconPathData = "M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1.5 14.5l-4-4 1.41-1.41L10.5 13.67l6.09-6.09 1.41 1.41-7.5 7.51z"
            });
        }

        private static void BuildAndShowGui() {
            string xaml = @"
<Window xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
        xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml""
        Title=""VPNDS • Painel de Controle"" Height=""870"" Width=""580""
        WindowStartupLocation=""CenterScreen"" ResizeMode=""CanMinimize""
        Background=""#09090B"" Foreground=""#F4F4F5"" FontFamily=""Segoe UI"">
    <Window.Resources>
        <Style TargetType=""Button"">
            <Setter Property=""Cursor"" Value=""Hand""/>
            <Setter Property=""FontWeight"" Value=""SemiBold""/>
            <Setter Property=""BorderThickness"" Value=""0""/>
        </Style>
    </Window.Resources>

    <Grid Margin=""18"">
        <Grid.RowDefinitions>
            <RowDefinition Height=""Auto""/> <!-- 0. Header -->
            <RowDefinition Height=""Auto""/> <!-- 1. Update Card -->
            <RowDefinition Height=""Auto""/> <!-- 2. Status Card -->
            <RowDefinition Height=""Auto""/> <!-- 3. VPN Leve GoodbyeDPI Card -->
            <RowDefinition Height=""Auto""/> <!-- 4. Discord 1ms VPN Card -->
            <RowDefinition Height=""Auto""/> <!-- 5. Master Restore Button -->
            <RowDefinition Height=""*""/>    <!-- 6. Provider Cards Scrollable -->
            <RowDefinition Height=""Auto""/> <!-- 7. Original DNS edit -->
            <RowDefinition Height=""Auto""/> <!-- 8. Status Log -->
        </Grid.RowDefinitions>

        <!-- 0. HEADER -->
        <Border Grid.Row=""0"" Margin=""0,0,0,14"">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width=""Auto""/>
                    <ColumnDefinition Width=""*""/>
                    <ColumnDefinition Width=""Auto""/>
                </Grid.ColumnDefinitions>

                <!-- LOGO DO TOPO COM IMAGEM REAL DO ESCUDO -->
                <Border Grid.Column=""0"" Background=""#141418"" CornerRadius=""12"" Width=""48"" Height=""48"" Margin=""0,0,14,0"" BorderBrush=""#27272A"" BorderThickness=""1.2"" ClipToBounds=""True"">
                    <Grid>
                        <Image Name=""ImgHeaderLogo"" Width=""40"" Height=""40"" RenderOptions.BitmapScalingMode=""HighQuality"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                        <Path Name=""PathFallbackLogo"" Data=""M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v6h-2V7zm0 8h2v2h-2v-2z"" Fill=""#FFFFFF"" Stretch=""Uniform"" Width=""22"" Height=""22"" Visibility=""Collapsed"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                    </Grid>
                </Border>

                <StackPanel Grid.Column=""1"" VerticalAlignment=""Center"">
                    <StackPanel Orientation=""Horizontal"">
                        <TextBlock Text=""VPNDS"" FontSize=""19"" FontWeight=""Black"" Foreground=""#FFFFFF"" />
                        <Border Background=""#1C1C22"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""5"" Padding=""6,2"" Margin=""8,0,0,0"" VerticalAlignment=""Center"">
                            <TextBlock Text=""PRO EDITION"" FontSize=""8.5"" FontWeight=""Bold"" Foreground=""#A1A1AA""/>
                        </Border>
                        <Border Background=""#18181C"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""5"" Padding=""5,2"" Margin=""6,0,0,0"" VerticalAlignment=""Center"">
                            <TextBlock Name=""TxtCurrentVersionBadge"" Text=""v1.1.0"" FontSize=""8.5"" FontWeight=""Bold"" Foreground=""#60A5FA""/>
                        </Border>
                    </StackPanel>
                    <TextBlock Text=""DNS Seguro IPv4+IPv6 • Bypass DPI • Rota Discord 1ms"" FontSize=""10.5"" Foreground=""#71717A"" Margin=""0,2,0,0""/>
                </StackPanel>

                <!-- HEADER BUTTONS: ATUALIZACOES, RESETAR IP & TESTAR PINGS -->
                <StackPanel Grid.Column=""2"" Orientation=""Horizontal"" VerticalAlignment=""Center"">
                    <Button Name=""BtnCheckUpdate"" Height=""32"" Padding=""8,0"" Margin=""0,0,6,0"" ToolTip=""Verificar se ha nova versao no GitHub"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""borderUpdate"" Background=""#141418"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""8"">
                                    <StackPanel Orientation=""Horizontal"" Margin=""6,0"" VerticalAlignment=""Center"">
                                        <Path Data=""M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"" Fill=""#60A5FA"" Stretch=""Uniform"" Width=""11"" Height=""11"" Margin=""0,0,5,0"" VerticalAlignment=""Center""/>
                                        <TextBlock Text=""Atualizar"" FontSize=""10.5"" FontWeight=""Bold"" Foreground=""#E4E4E7"" VerticalAlignment=""Center""/>
                                    </StackPanel>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""borderUpdate"" Property=""Background"" Value=""#27272A""/>
                                        <Setter TargetName=""borderUpdate"" Property=""BorderBrush"" Value=""#3B82F6""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>

                    <Button Name=""BtnResetIp"" Height=""32"" Padding=""10,0"" Margin=""0,0,6,0"" ToolTip=""Renova o IP da sua rede (DHCP) e gera nova rota de IP publico"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""borderReset"" Background=""#141418"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""8"">
                                    <StackPanel Orientation=""Horizontal"" Margin=""8,0"" VerticalAlignment=""Center"">
                                        <Path Data=""M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"" Fill=""#A1A1AA"" Stretch=""Uniform"" Width=""11"" Height=""11"" Margin=""0,0,6,0"" VerticalAlignment=""Center""/>
                                        <TextBlock Text=""Resetar IP"" FontSize=""10.5"" FontWeight=""Bold"" Foreground=""#E4E4E7"" VerticalAlignment=""Center""/>
                                    </StackPanel>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""borderReset"" Property=""Background"" Value=""#27272A""/>
                                        <Setter TargetName=""borderReset"" Property=""BorderBrush"" Value=""#3F3F46""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>

                    <Button Name=""BtnPingAll"" Height=""32"" Padding=""10,0"" VerticalAlignment=""Center"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""border"" Background=""#141418"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""8"">
                                    <TextBlock Text=""Testar Pings"" FontSize=""10.5"" FontWeight=""Bold"" Foreground=""#E4E4E7"" Margin=""8,0"" VerticalAlignment=""Center""/>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""border"" Property=""Background"" Value=""#27272A""/>
                                        <Setter TargetName=""border"" Property=""BorderBrush"" Value=""#3F3F46""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>
                </StackPanel>
            </Grid>
        </Border>

        <!-- 1. CARD DE ATUALIZACAO AUTOMATICA (APARECE QUANDO HOUVER NOVA VERSAO) -->
        <Border Grid.Row=""1"" Name=""UpdateCard"" Visibility=""Collapsed"" Background=""#0C1929"" BorderBrush=""#2563EB"" BorderThickness=""1.5"" CornerRadius=""12"" Padding=""14,12"" Margin=""0,0,0,10"">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width=""Auto""/>
                    <ColumnDefinition Width=""*""/>
                    <ColumnDefinition Width=""Auto""/>
                </Grid.ColumnDefinitions>

                <Border Background=""#172554"" CornerRadius=""8"" Width=""38"" Height=""38"" Margin=""0,0,12,0"" VerticalAlignment=""Center"" BorderBrush=""#3B82F6"" BorderThickness=""1"">
                    <Path Data=""M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"" Fill=""#60A5FA"" Stretch=""Uniform"" Width=""18"" Height=""18"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                </Border>

                <StackPanel Grid.Column=""1"" VerticalAlignment=""Center"" Margin=""0,0,10,0"">
                    <StackPanel Orientation=""Horizontal"">
                        <TextBlock Text=""NOVA VERSÃO DISPONÍVEL!"" FontWeight=""Black"" FontSize=""11.5"" Foreground=""#60A5FA""/>
                        <Border Background=""#1D4ED8"" CornerRadius=""4"" Padding=""5,1"" Margin=""6,0,0,0"" VerticalAlignment=""Center"">
                            <TextBlock Name=""TxtUpdateVersion"" Text=""v1.2.0"" FontSize=""8.5"" FontWeight=""Bold"" Foreground=""#FFFFFF""/>
                        </Border>
                    </StackPanel>
                    <TextBlock Name=""TxtUpdateDesc"" Text=""Uma nova atualização com melhorias está pronta para você."" FontSize=""9.5"" Foreground=""#94A3B8"" Margin=""0,2,0,0"" TextWrapping=""Wrap""/>
                    <TextBlock Name=""TxtUpdateProgress"" Text="""" FontSize=""9"" FontWeight=""SemiBold"" Foreground=""#38BDF8"" Margin=""0,2,0,0"" Visibility=""Collapsed""/>
                </StackPanel>

                <StackPanel Grid.Column=""2"" Orientation=""Horizontal"" VerticalAlignment=""Center"">
                    <Button Name=""BtnChangelog"" Height=""32"" Padding=""8,0"" Margin=""0,0,6,0"" ToolTip=""Ver novidades da atualizacao"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""bChangelog"" Background=""#1E293B"" BorderBrush=""#334155"" BorderThickness=""1"" CornerRadius=""7"">
                                    <TextBlock Text=""Novidades"" FontSize=""10"" FontWeight=""Bold"" Foreground=""#CBD5E1"" Margin=""6,0"" VerticalAlignment=""Center""/>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""bChangelog"" Property=""Background"" Value=""#334155""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>

                    <Button Name=""BtnApplyUpdate"" Height=""32"" Width=""130"" VerticalAlignment=""Center"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""borderBtnApply"" Background=""#2563EB"" CornerRadius=""7"">
                                    <TextBlock Name=""txtBtnApply"" Text=""ATUALIZAR AGORA"" FontSize=""10"" FontWeight=""Black"" Foreground=""#FFFFFF"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""borderBtnApply"" Property=""Background"" Value=""#1D4ED8""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>
                </StackPanel>
            </Grid>
        </Border>

        <!-- 2. STATUS CARD -->
        <Border Grid.Row=""2"" Name=""StatusCard"" Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1.2"" CornerRadius=""12"" Padding=""14,12"" Margin=""0,0,0,10"">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width=""Auto""/>
                    <ColumnDefinition Width=""*""/>
                    <ColumnDefinition Width=""Auto""/>
                </Grid.ColumnDefinitions>

                <Ellipse Name=""StatusDot"" Width=""12"" Height=""12"" Fill=""#71717A"" Margin=""0,0,14,0"" VerticalAlignment=""Center""/>

                <StackPanel Grid.Column=""1"" VerticalAlignment=""Center"">
                    <TextBlock Name=""StatusTitle"" Text=""STATUS DA CONEXAO"" FontSize=""9"" FontWeight=""SemiBold"" Foreground=""#71717A""/>
                    <TextBlock Name=""StatusValue"" Text=""Consultando conexao..."" FontSize=""13"" FontWeight=""Bold"" Foreground=""#FFFFFF"" Margin=""0,2,0,0""/>
                    <TextBlock Name=""StatusAdapter"" Text=""Placa de Rede: Detectando..."" FontSize=""9.5"" Foreground=""#52525B"" Margin=""0,2,0,0""/>
                </StackPanel>

                <Border Grid.Column=""2"" Name=""StatusBadge"" Background=""#1C1C22"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""6"" Padding=""8,4"" VerticalAlignment=""Center"">
                    <TextBlock Name=""StatusBadgeText"" Text=""PADRAO"" FontSize=""9"" FontWeight=""Bold"" Foreground=""#A1A1AA""/>
                </Border>
            </Grid>
        </Border>

        <!-- 3. MODO VPN LEVE (GOODBYEDPI • SEM CONTA • 1MS) -->
        <Border Grid.Row=""3"" Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1.2"" CornerRadius=""12"" Padding=""14,12"" Margin=""0,0,0,10"">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width=""Auto""/>
                    <ColumnDefinition Width=""*""/>
                    <ColumnDefinition Width=""Auto""/>
                </Grid.ColumnDefinitions>

                <!-- Icone Vetorial de Raio / Bypass -->
                <Border Background=""#18181C"" CornerRadius=""8"" Width=""38"" Height=""38"" Margin=""0,0,12,0"" VerticalAlignment=""Center"" BorderBrush=""#27272A"" BorderThickness=""1"">
                    <Path Data=""M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.66 0 .8.54.42 1.02L11 21z"" Fill=""#FFFFFF"" Stretch=""Uniform"" Width=""16"" Height=""16"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                </Border>

                <StackPanel Grid.Column=""1"" VerticalAlignment=""Center"">
                    <StackPanel Orientation=""Horizontal"">
                        <TextBlock Text=""VPN Leve • Bypass DPI"" FontWeight=""Bold"" FontSize=""12.5"" Foreground=""#FFFFFF""/>
                        <Border Name=""BadgeVpnStatus"" Background=""#1C1C22"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""5"" Padding=""6,2"" Margin=""8,0,0,0"" VerticalAlignment=""Center"">
                            <TextBlock Name=""TxtVpnStatus"" Text=""DESLIGADO"" FontSize=""8.5"" FontWeight=""Bold"" Foreground=""#71717A""/>
                        </Border>
                    </StackPanel>
                    <TextBlock Text=""Desbloqueia sites e Discord sem trocar rota ou IP. 1ms nativo."" FontSize=""9"" Foreground=""#71717A"" Margin=""0,2,0,0""/>
                </StackPanel>

                <Button Name=""BtnToggleVpn"" Grid.Column=""2"" Height=""32"" Width=""110"" VerticalAlignment=""Center"">
                    <Button.Template>
                        <ControlTemplate TargetType=""Button"">
                            <Border Name=""borderVpn"" Background=""#FFFFFF"" CornerRadius=""7"">
                                <TextBlock Name=""txtBtnVpn"" Text=""LIGAR"" FontSize=""10.5"" FontWeight=""Bold"" Foreground=""#09090B"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                            </Border>
                        </ControlTemplate>
                    </Button.Template>
                </Button>
            </Grid>
        </Border>

        <!-- 4. MODO VPN DISCORD (DESBLOQUEIO DE TELA • 1MS NATIVO • AUTO 2 MIN) -->
        <Border Grid.Row=""4"" Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1.2"" CornerRadius=""12"" Padding=""14,12"" Margin=""0,0,0,10"">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width=""Auto""/>
                    <ColumnDefinition Width=""*""/>
                    <ColumnDefinition Width=""Auto""/>
                </Grid.ColumnDefinitions>

                <!-- Icone Vetorial Oficial do Discord (Clyde) -->
                <Border Background=""#18181C"" CornerRadius=""8"" Width=""38"" Height=""38"" Margin=""0,0,12,0"" VerticalAlignment=""Center"" BorderBrush=""#27272A"" BorderThickness=""1"">
                    <Path Data=""M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.02.06.03.09.02 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.76-8.46-3.1-11.95-.01-.01-.02-.02-.03-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z"" Fill=""#FFFFFF"" Stretch=""Uniform"" Width=""18"" Height=""18"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                </Border>

                <StackPanel Grid.Column=""1"" VerticalAlignment=""Center"">
                    <StackPanel Orientation=""Horizontal"">
                        <TextBlock Text=""VPN no Discord • Tela Liberada"" FontWeight=""Bold"" FontSize=""12.5"" Foreground=""#FFFFFF""/>
                        <Border Name=""BadgeDiscordStatus"" Background=""#1C1C22"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""5"" Padding=""6,2"" Margin=""8,0,0,0"" VerticalAlignment=""Center"">
                            <TextBlock Name=""TxtDiscordStatus"" Text=""VERIFICANDO..."" FontSize=""8.5"" FontWeight=""Bold"" Foreground=""#71717A""/>
                        </Border>
                    </StackPanel>
                    <TextBlock Text=""Desbloqueio definitivo • Voz/Vídeo 1ms nativo • 100% Permanente"" FontSize=""9"" Foreground=""#71717A"" Margin=""0,2,0,0""/>
                </StackPanel>

                <StackPanel Grid.Column=""2"" Orientation=""Horizontal"" VerticalAlignment=""Center"">
                    <Button Name=""BtnRestartDiscord"" Height=""32"" Padding=""8,0"" Margin=""0,0,6,0"" ToolTip=""Reinicia o Discord rapidamente para destravar a camera e a conexao"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""borderRestart"" Background=""#18181C"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""7"">
                                    <StackPanel Orientation=""Horizontal"" Margin=""6,0"" VerticalAlignment=""Center"">
                                        <Path Data=""M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"" Fill=""#A1A1AA"" Stretch=""Uniform"" Width=""11"" Height=""11"" Margin=""0,0,5,0"" VerticalAlignment=""Center""/>
                                        <TextBlock Text=""Reiniciar"" FontSize=""10"" FontWeight=""Bold"" Foreground=""#E4E4E7"" VerticalAlignment=""Center""/>
                                    </StackPanel>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""borderRestart"" Property=""Background"" Value=""#27272A""/>
                                        <Setter TargetName=""borderRestart"" Property=""BorderBrush"" Value=""#3F3F46""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>

                    <Button Name=""BtnToggleDiscord"" Height=""32"" Width=""100"" VerticalAlignment=""Center"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""borderDiscord"" Background=""#FFFFFF"" CornerRadius=""7"">
                                    <TextBlock Name=""txtBtnDiscord"" Text=""ATIVAR"" FontSize=""10.5"" FontWeight=""Bold"" Foreground=""#09090B"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                                </Border>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>
                </StackPanel>
            </Grid>
        </Border>

        <!-- 5. BOTAO MESTRE DE DESATIVAR / VOLTAR PARA O MEU DNS -->
        <Button Name=""BtnRestoreMaster"" Grid.Row=""5"" Height=""42"" Margin=""0,0,0,10"" ToolTip=""Desativa a VPN e volta imediatamente para o seu DNS original"">
            <Button.Template>
                <ControlTemplate TargetType=""Button"">
                    <Border Name=""border"" Background=""#18181C"" BorderBrush=""#3F3F46"" BorderThickness=""1.2"" CornerRadius=""10"">
                        <Grid HorizontalAlignment=""Center"" VerticalAlignment=""Center"">
                            <StackPanel Orientation=""Horizontal"">
                                <TextBlock Text=""Voltar para meu DNS Original ("" FontSize=""11.5"" FontWeight=""SemiBold"" Foreground=""#A1A1AA"" VerticalAlignment=""Center""/>
                                <TextBlock Name=""LblMasterOrig"" Text=""192.168.0.113"" FontSize=""11.5"" FontWeight=""Bold"" Foreground=""#FFFFFF"" VerticalAlignment=""Center""/>
                                <TextBlock Text="")"" FontSize=""11.5"" FontWeight=""SemiBold"" Foreground=""#A1A1AA"" VerticalAlignment=""Center""/>
                            </StackPanel>
                        </Grid>
                    </Border>
                    <ControlTemplate.Triggers>
                        <Trigger Property=""IsMouseOver"" Value=""True"">
                            <Setter TargetName=""border"" Property=""Background"" Value=""#27272A""/>
                            <Setter TargetName=""border"" Property=""BorderBrush"" Value=""#52525B""/>
                        </Trigger>
                    </ControlTemplate.Triggers>
                </ControlTemplate>
            </Button.Template>
        </Button>

        <!-- 6. CARDS DE DNS -->
        <ScrollViewer Grid.Row=""6"" VerticalScrollBarVisibility=""Auto"" Margin=""0,0,0,10"">
            <StackPanel Name=""CardsPanel"">
                <!-- Gerados via codigo -->
            </StackPanel>
        </ScrollViewer>

        <!-- 7. CONFIGURACOES DE RETORNO -->
        <Border Grid.Row=""7"" Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""10"" Padding=""12,10"" Margin=""0,0,0,8"">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width=""*""/>
                    <ColumnDefinition Width=""Auto""/>
                </Grid.ColumnDefinitions>

                <StackPanel Grid.Column=""0"" VerticalAlignment=""Center"">
                    <TextBlock Text=""IP do seu DNS Original de Retorno:"" FontSize=""10"" FontWeight=""SemiBold"" Foreground=""#A1A1AA""/>
                    <TextBlock Text=""Configurado na sua rede local (ex: Pi-hole, AdGuard ou Roteador)"" FontSize=""9"" Foreground=""#52525B""/>
                </StackPanel>

                <TextBox Name=""TxtOriginalDns"" Grid.Column=""1"" Width=""140"" Height=""26"" Background=""#18181C"" Foreground=""#FFFFFF"" 
                         BorderBrush=""#27272A"" BorderThickness=""1"" VerticalContentAlignment=""Center"" HorizontalContentAlignment=""Center"" 
                         FontWeight=""Bold"" FontSize=""11"" Text=""192.168.0.113""/>
            </Grid>
        </Border>

        <!-- 8. LOG DE ATIVIDADE -->
        <Border Grid.Row=""8"" Background=""#0C0C0E"" CornerRadius=""8"" BorderBrush=""#27272A"" BorderThickness=""1"" Padding=""7"">
            <TextBlock Name=""TxtStatusLog"" Text=""Pronto. Selecione qualquer DNS ou ative os recursos."" FontSize=""9.5"" Foreground=""#71717A""/>
        </Border>
    </Grid>
</Window>";

            using (StringReader sr = new StringReader(xaml)) {
                using (XmlReader xr = XmlReader.Create(sr)) {
                    _window = (Window)XamlReader.Load(xr);
                }
            }

            try {
                string iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app_vpnds.ico");
                if (!File.Exists(iconPath)) {
                    iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                }
                if (File.Exists(iconPath)) {
                    _window.Icon = new System.Windows.Media.Imaging.BitmapImage(new Uri(iconPath));
                }
            } catch { }

            // Carrega imagem da Logo no cabecalho
            Image imgHeaderLogo = (Image)_window.FindName("ImgHeaderLogo");
            System.Windows.Shapes.Path pathFallbackLogo = (System.Windows.Shapes.Path)_window.FindName("PathFallbackLogo");
            try {
                string logoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app_preview.png");
                if (!File.Exists(logoPath)) {
                    logoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app_vpnds.ico");
                }
                if (File.Exists(logoPath) && imgHeaderLogo != null) {
                    System.Windows.Media.Imaging.BitmapImage bi = new System.Windows.Media.Imaging.BitmapImage();
                    bi.BeginInit();
                    bi.UriSource = new Uri(logoPath, UriKind.Absolute);
                    bi.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
                    bi.EndInit();
                    imgHeaderLogo.Source = bi;
                } else if (pathFallbackLogo != null) {
                    pathFallbackLogo.Visibility = Visibility.Visible;
                }
            } catch {
                if (pathFallbackLogo != null) pathFallbackLogo.Visibility = Visibility.Visible;
            }

            _updateCard = (Border)_window.FindName("UpdateCard");
            _txtUpdateVersion = (TextBlock)_window.FindName("TxtUpdateVersion");
            _txtUpdateDesc = (TextBlock)_window.FindName("TxtUpdateDesc");
            _txtUpdateProgress = (TextBlock)_window.FindName("TxtUpdateProgress");
            _btnChangelog = (Button)_window.FindName("BtnChangelog");
            _btnApplyUpdate = (Button)_window.FindName("BtnApplyUpdate");
            _btnCheckUpdate = (Button)_window.FindName("BtnCheckUpdate");

            TextBlock txtCurrentVersionBadge = (TextBlock)_window.FindName("TxtCurrentVersionBadge");
            if (txtCurrentVersionBadge != null) {
                txtCurrentVersionBadge.Text = "v" + CURRENT_VERSION;
            }

            _statusCard = (Border)_window.FindName("StatusCard");
            _statusDot = (System.Windows.Shapes.Ellipse)_window.FindName("StatusDot");
            _statusTitle = (TextBlock)_window.FindName("StatusTitle");
            _statusValue = (TextBlock)_window.FindName("StatusValue");
            _statusAdapter = (TextBlock)_window.FindName("StatusAdapter");
            _statusBadge = (Border)_window.FindName("StatusBadge");
            _statusBadgeText = (TextBlock)_window.FindName("StatusBadgeText");

            _badgeVpnStatus = (Border)_window.FindName("BadgeVpnStatus");
            _txtVpnStatus = (TextBlock)_window.FindName("TxtVpnStatus");
            _btnToggleVpn = (Button)_window.FindName("BtnToggleVpn");

            _badgeDiscordStatus = (Border)_window.FindName("BadgeDiscordStatus");
            _txtDiscordStatus = (TextBlock)_window.FindName("TxtDiscordStatus");
            _btnToggleDiscord = (Button)_window.FindName("BtnToggleDiscord");
            _btnRestartDiscord = (Button)_window.FindName("BtnRestartDiscord");

            _btnRestoreMaster = (Button)_window.FindName("BtnRestoreMaster");
            _lblMasterOrig = (TextBlock)_window.FindName("LblMasterOrig");
            _btnResetIp = (Button)_window.FindName("BtnResetIp");
            _btnPingAll = (Button)_window.FindName("BtnPingAll");
            _cardsPanel = (StackPanel)_window.FindName("CardsPanel");
            _txtOriginalDns = (TextBox)_window.FindName("TxtOriginalDns");
            _txtStatusLog = (TextBlock)_window.FindName("TxtStatusLog");

            _txtOriginalDns.Text = _originalDns;
            if (_lblMasterOrig != null) {
                _lblMasterOrig.Text = _originalDns;
            }

            _txtOriginalDns.LostFocus += (s, e) => {
                string novo = _txtOriginalDns.Text.Trim();
                if (!string.IsNullOrEmpty(novo)) {
                    _originalDns = novo;
                    if (_lblMasterOrig != null) {
                        _lblMasterOrig.Text = _originalDns;
                    }
                    SaveConfig();
                    RefreshStatus();
                }
            };

            _btnRestoreMaster.Click += (s, e) => {
                RestoreOriginal();
            };

            if (_btnCheckUpdate != null) {
                _btnCheckUpdate.Click += (s, e) => {
                    CheckForUpdates(true);
                };
            }

            if (_btnChangelog != null) {
                _btnChangelog.Click += (s, e) => {
                    ShowChangelog();
                };
            }

            if (_btnApplyUpdate != null) {
                _btnApplyUpdate.Click += (s, e) => {
                    ExecuteAutoUpdate();
                };
            }

            if (_btnResetIp != null) {
                _btnResetIp.Click += (s, e) => {
                    HandleResetIp();
                };
            }

            _btnPingAll.Click += async (s, e) => {
                await PingAllProviders();
            };

            _btnToggleVpn.Click += (s, e) => {
                HandleVpnToggle();
            };

            _btnToggleDiscord.Click += (s, e) => {
                HandleDiscordToggle();
            };

            if (_btnRestartDiscord != null) {
                _btnRestartDiscord.Click += (s, e) => {
                    HandleRestartDiscord();
                };
            }

            BuildProviderCards();
            UpdateVpnStatus();
            RefreshDiscordStatus();
            RefreshStatus();

            CheckForUpdates(false);

            Task.Run(() => {
                EnsureTorAndVpnBootReady();
                if (_window != null) {
                    _window.Dispatcher.Invoke(() => {
                        UpdateVpnStatus();
                        RefreshStatus();
                    });
                }
            });

            string[] args = Environment.GetCommandLineArgs();
            bool isMinimized = false;
            foreach (string arg in args) {
                if (arg.Equals("--minimized", StringComparison.OrdinalIgnoreCase) || arg.Equals("-minimized", StringComparison.OrdinalIgnoreCase)) {
                    isMinimized = true;
                    break;
                }
            }
            if (isMinimized) {
                _window.WindowState = WindowState.Minimized;
            }

            _window.ShowDialog();
        }

        private static void BuildProviderCards() {
            _cardsPanel.Children.Clear();

            foreach (var prov in _providers) {
                Border card = new Border {
                    Background = (Brush)_bc.ConvertFromString("#121216"),
                    BorderBrush = (Brush)_bc.ConvertFromString("#27272A"),
                    BorderThickness = new Thickness(1.2),
                    CornerRadius = new CornerRadius(10),
                    Padding = new Thickness(12, 10, 12, 10),
                    Margin = new Thickness(0, 0, 0, 8),
                    Cursor = System.Windows.Input.Cursors.Hand
                };

                Grid g = new Grid();
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                // Corporate Vector Logo Icon Box
                Border iconBox = new Border {
                    Background = (Brush)_bc.ConvertFromString("#18181C"),
                    BorderBrush = (Brush)_bc.ConvertFromString("#27272A"),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(8),
                    Width = 38,
                    Height = 38,
                    Margin = new Thickness(0, 0, 12, 0),
                    VerticalAlignment = VerticalAlignment.Center
                };
                System.Windows.Shapes.Path iconPath = new System.Windows.Shapes.Path {
                    Data = Geometry.Parse(prov.IconPathData),
                    Fill = Brushes.White,
                    Stretch = Stretch.Uniform,
                    Width = 18,
                    Height = 18,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                };
                iconBox.Child = iconPath;
                Grid.SetColumn(iconBox, 0);
                g.Children.Add(iconBox);

                // Middle Info
                StackPanel sp = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                StackPanel titleRow = new StackPanel { Orientation = Orientation.Horizontal };
                
                TextBlock title = new TextBlock {
                    Text = prov.Name,
                    FontWeight = FontWeights.Bold,
                    FontSize = 13,
                    Foreground = (Brush)_bc.ConvertFromString("#FFFFFF")
                };
                titleRow.Children.Add(title);

                TextBlock ips = new TextBlock {
                    Text = " (" + prov.Primary + ")",
                    FontSize = 10,
                    Foreground = (Brush)_bc.ConvertFromString("#71717A"),
                    VerticalAlignment = VerticalAlignment.Center
                };
                titleRow.Children.Add(ips);
                sp.Children.Add(titleRow);

                TextBlock desc = new TextBlock {
                    Text = prov.Desc,
                    FontSize = 9.5,
                    Foreground = (Brush)_bc.ConvertFromString("#71717A"),
                    Margin = new Thickness(0, 2, 0, 0)
                };
                sp.Children.Add(desc);
                Grid.SetColumn(sp, 1);
                g.Children.Add(sp);

                // In-use Badge
                Border inUseBadge = new Border {
                    Background = (Brush)_bc.ConvertFromString("#142E1F"),
                    BorderBrush = (Brush)_bc.ConvertFromString("#064E3B"),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(5),
                    Padding = new Thickness(6, 2, 6, 2),
                    Margin = new Thickness(0, 0, 8, 0),
                    VerticalAlignment = VerticalAlignment.Center,
                    Visibility = Visibility.Collapsed
                };
                TextBlock inUseTxt = new TextBlock {
                    Text = "EM USO",
                    FontSize = 8.5,
                    FontWeight = FontWeights.Bold,
                    Foreground = (Brush)_bc.ConvertFromString("#34D399")
                };
                inUseBadge.Child = inUseTxt;
                prov.StatusInUseBadge = inUseBadge;

                // Ping Badge
                Border pingBadge = new Border {
                    Background = (Brush)_bc.ConvertFromString("#18181C"),
                    BorderBrush = (Brush)_bc.ConvertFromString("#27272A"),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(5),
                    Padding = new Thickness(7, 3, 7, 3),
                    VerticalAlignment = VerticalAlignment.Center
                };
                TextBlock pingTxt = new TextBlock {
                    Text = prov.Badge,
                    FontSize = 8.5,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = (Brush)_bc.ConvertFromString("#A1A1AA")
                };
                pingBadge.Child = pingTxt;
                prov.PingTextBlock = pingTxt;

                // Stack for Badges
                StackPanel badgeCol = new StackPanel { 
                    Orientation = Orientation.Horizontal, 
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(0, 0, 10, 0)
                };
                badgeCol.Children.Add(inUseBadge);
                badgeCol.Children.Add(pingBadge);
                Grid.SetColumn(badgeCol, 2);
                g.Children.Add(badgeCol);

                // Action Button "ATIVAR / DESATIVAR"
                Border btnBorder = new Border {
                    Background = (Brush)_bc.ConvertFromString("#FFFFFF"),
                    CornerRadius = new CornerRadius(7),
                    Height = 32,
                    Width = 94,
                    Cursor = System.Windows.Input.Cursors.Hand
                };

                TextBlock btnTxt = new TextBlock {
                    Text = "ATIVAR",
                    FontSize = 10.5,
                    FontWeight = FontWeights.Bold,
                    Foreground = (Brush)_bc.ConvertFromString("#09090B"),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                };
                btnBorder.Child = btnTxt;

                Button actBtn = new Button {
                    Content = btnBorder,
                    Background = Brushes.Transparent,
                    BorderThickness = new Thickness(0),
                    Cursor = System.Windows.Input.Cursors.Hand,
                    VerticalAlignment = VerticalAlignment.Center
                };

                prov.ActionButton = actBtn;
                prov.ActionBorder = btnBorder;
                prov.ActionText = btnTxt;

                DnsProvider targetProv = prov;
                actBtn.Click += (s, e) => {
                    ToggleProvider(targetProv);
                };

                card.MouseDown += (s, e) => {
                    if (e.OriginalSource != actBtn && e.OriginalSource != btnBorder && e.OriginalSource != btnTxt) {
                        ToggleProvider(targetProv);
                    }
                };

                Grid.SetColumn(actBtn, 3);
                g.Children.Add(actBtn);

                card.Child = g;
                prov.CardBorder = card;

                _cardsPanel.Children.Add(card);
            }
        }

        // ================= GOODBYEDPI CONTROLLER =================
        private static bool IsGdpiRunning() {
            try {
                Process[] procs = Process.GetProcessesByName("goodbyedpi");
                return procs != null && procs.Length > 0;
            } catch {
                return false;
            }
        }

        private static void StartGdpi() {
            try {
                if (IsGdpiRunning()) return;

                string coreDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "core");
                string gdpiExe = Path.Combine(coreDir, "goodbyedpi.exe");

                if (!File.Exists(gdpiExe)) {
                    MessageBox.Show("Arquivo core\\goodbyedpi.exe nao encontrado!", "Aviso", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }

                // Modo -1 e mais compativel e menos agressivo com servicos anti-DDoS (como DDoS-Guard e Cloudflare)
                ProcessStartInfo psi = new ProcessStartInfo {
                    FileName = gdpiExe,
                    Arguments = "-1",
                    WorkingDirectory = coreDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                Process.Start(psi);
            } catch (Exception ex) {
                MessageBox.Show("Erro ao iniciar GoodbyeDPI:\n" + ex.Message, "Erro", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private static void StopGdpi() {
            try {
                ProcessStartInfo kPsi = new ProcessStartInfo {
                    FileName = "taskkill.exe",
                    Arguments = "/F /IM goodbyedpi.exe",
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                using (Process kp = Process.Start(kPsi)) {
                    if (kp != null) { kp.WaitForExit(300); }
                }
            } catch { }

            try {
                Process[] procs = Process.GetProcessesByName("goodbyedpi");
                foreach (Process p in procs) {
                    try { p.Kill(); } catch { }
                }
            } catch { }
        }

        private static void UpdateVpnStatus() {
            bool running = IsGdpiRunning();
            if (running) {
                _txtVpnStatus.Text = "LIGADO • 1ms";
                _badgeVpnStatus.Background = (Brush)_bc.ConvertFromString("#142E1F");
                _txtVpnStatus.Foreground = (Brush)_bc.ConvertFromString("#34D399");

                SetVpnButtonVisual("DESLIGAR", "#27272A", "#F87171", "#EF4444");
            } else {
                _txtVpnStatus.Text = "DESLIGADO";
                _badgeVpnStatus.Background = (Brush)_bc.ConvertFromString("#1C1C22");
                _txtVpnStatus.Foreground = (Brush)_bc.ConvertFromString("#71717A");

                SetVpnButtonVisual("LIGAR", "#FFFFFF", "#09090B", null);
            }
        }

        private static void SetVpnButtonVisual(string text, string hexBg, string hexFg, string hexBorder) {
            _borderVpn = (Border)_btnToggleVpn.Template.FindName("borderVpn", _btnToggleVpn);
            _txtBtnVpn = (TextBlock)_btnToggleVpn.Template.FindName("txtBtnVpn", _btnToggleVpn);
            if (_borderVpn != null) {
                _borderVpn.Background = (Brush)_bc.ConvertFromString(hexBg);
                if (!string.IsNullOrEmpty(hexBorder)) {
                    _borderVpn.BorderBrush = (Brush)_bc.ConvertFromString(hexBorder);
                    _borderVpn.BorderThickness = new Thickness(1);
                } else {
                    _borderVpn.BorderThickness = new Thickness(0);
                }
            }
            if (_txtBtnVpn != null) {
                _txtBtnVpn.Text = text;
                _txtBtnVpn.Foreground = (Brush)_bc.ConvertFromString(hexFg);
            }
        }

        private static async void HandleVpnToggle() {
            if (_btnToggleVpn == null) return;
            _btnToggleVpn.IsEnabled = false;

            if (IsGdpiRunning()) {
                _txtStatusLog.Text = "Desligando VPN Leve (Bypass DPI)...";
                await Task.Run(() => StopGdpi());
                _txtStatusLog.Text = "VPN Leve Desligada!";
            } else {
                _txtStatusLog.Text = "Ligando VPN Leve (Bypass DPI para Discord)...";
                await Task.Run(() => {
                    StartGdpi();
                    for (int i = 0; i < 6; i++) {
                        if (IsGdpiRunning()) break;
                        System.Threading.Thread.Sleep(50);
                    }
                });
                if (IsGdpiRunning()) {
                    _txtStatusLog.Text = "VPN Leve Ativa! (1ms nativo de ping).";
                } else {
                    _txtStatusLog.Text = "Falha ao iniciar GoodbyeDPI. Verifique permissoes de administrador.";
                }
            }

            _btnToggleVpn.IsEnabled = true;
            UpdateVpnStatus();
            RefreshStatus();
        }

        // ================= DISCORD 1MS VPN CONTROLLER =================
        private static void RefreshDiscordStatus() {
            Task.Run(() => {
                try {
                    string coreDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "core");
                    string script = Path.Combine(coreDir, "discord_vpn_manager.ps1");
                    if (!File.Exists(script)) return;

                    ProcessStartInfo psi = new ProcessStartInfo {
                        FileName = "powershell.exe",
                        Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Action Status",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true
                    };
                    using (Process proc = Process.Start(psi)) {
                        string output = proc.StandardOutput.ReadToEnd().Trim();
                        proc.WaitForExit();
                        _discordInstalled = (output == "Installed");
                    }

                    if (_discordInstalled) {
                        try {
                            ProcessStartInfo psiAuto = new ProcessStartInfo {
                                FileName = "powershell.exe",
                                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Action AutoPatch",
                                CreateNoWindow = true,
                                UseShellExecute = false
                            };
                            using (Process pAuto = Process.Start(psiAuto)) {
                                pAuto.WaitForExit();
                            }
                        } catch { }
                    }

                    if (_window != null) {
                        _window.Dispatcher.Invoke(() => {
                            UpdateDiscordVisual();
                        });
                    }
                } catch { }
            });
        }

        private static void UpdateDiscordVisual() {
            try {
                if (_btnToggleDiscord == null) return;
                _borderDiscord = (Border)_btnToggleDiscord.Template.FindName("borderDiscord", _btnToggleDiscord);
                _txtBtnDiscord = (TextBlock)_btnToggleDiscord.Template.FindName("txtBtnDiscord", _btnToggleDiscord);

                if (_discordInstalled) {
                    _txtDiscordStatus.Text = "ATIVO • 100% PERMANENTE (1MS)";
                    _badgeDiscordStatus.Background = (Brush)_bc.ConvertFromString("#142E1F");
                    _txtDiscordStatus.Foreground = (Brush)_bc.ConvertFromString("#34D399");

                    if (_borderDiscord != null) {
                        _borderDiscord.Background = (Brush)_bc.ConvertFromString("#27272A");
                        _borderDiscord.BorderBrush = (Brush)_bc.ConvertFromString("#EF4444");
                        _borderDiscord.BorderThickness = new Thickness(1);
                    }
                    if (_txtBtnDiscord != null) {
                        _txtBtnDiscord.Text = "DESATIVAR";
                        _txtBtnDiscord.Foreground = (Brush)_bc.ConvertFromString("#F87171");
                    }
                } else {
                    _txtDiscordStatus.Text = "PADRAO (SEM VPN)";
                    _badgeDiscordStatus.Background = (Brush)_bc.ConvertFromString("#1C1C22");
                    _txtDiscordStatus.Foreground = (Brush)_bc.ConvertFromString("#71717A");

                    if (_borderDiscord != null) {
                        _borderDiscord.Background = (Brush)_bc.ConvertFromString("#FFFFFF");
                        _borderDiscord.BorderThickness = new Thickness(0);
                    }
                    if (_txtBtnDiscord != null) {
                        _txtBtnDiscord.Text = "ATIVAR";
                        _txtBtnDiscord.Foreground = (Brush)_bc.ConvertFromString("#09090B");
                    }
                }
            } catch { }
        }

        private static async void HandleDiscordToggle() {
            _btnToggleDiscord.IsEnabled = false;
            string coreDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "core");
            string script = Path.Combine(coreDir, "discord_vpn_manager.ps1");

            if (!File.Exists(script)) {
                MessageBox.Show("Arquivo core\\discord_vpn_manager.ps1 nao encontrado!", "Aviso", MessageBoxButton.OK, MessageBoxImage.Warning);
                _btnToggleDiscord.IsEnabled = true;
                return;
            }

            if (!_discordInstalled) {
                _txtStatusLog.Text = "Implementando VPN de 1ms no Discord (fechando Discord para aplicar)...";
                bool success = await Task.Run(() => {
                    try {
                        ProcessStartInfo psi = new ProcessStartInfo {
                            FileName = "powershell.exe",
                            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Action Install",
                            CreateNoWindow = true,
                            UseShellExecute = false,
                            RedirectStandardOutput = true
                        };
                        using (Process p = Process.Start(psi)) {
                            p.WaitForExit();
                            return p.ExitCode == 0;
                        }
                    } catch { return false; }
                });

                if (success) {
                    _txtStatusLog.Text = "VPN implementada com sucesso no Discord! Discord reaberto.";
                    _discordInstalled = true;
                    UpdateDiscordVisual();
                    MessageBox.Show(
                        "VPN de 1ms Implementada no Discord com Sucesso!\n\n" +
                        "Como funciona:\n" +
                        "1. Sempre que você abrir o Discord, a proteção de conexão fica 100% ativa automaticamente.\n" +
                        "2. A restrição de tela e câmera é desbloqueada de forma permanente.\n" +
                        "3. Voz, vídeo e jogos continuam usando sua rede direta com 1ms nativo de ping!\n" +
                        "4. 100% Automático: se o Discord atualizar de versão, ele se auto-corrige sozinho sem precisar clicar de novo!",
                        "Discord Liberado • 100% Permanente",
                        MessageBoxButton.OK,
                        MessageBoxImage.Information
                    );
                } else {
                    _txtStatusLog.Text = "Falha ao implementar VPN no Discord.";
                }
            } else {
                _txtStatusLog.Text = "Restaurando Discord original...";
                bool success = await Task.Run(() => {
                    try {
                        ProcessStartInfo psi = new ProcessStartInfo {
                            FileName = "powershell.exe",
                            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Action Uninstall",
                            CreateNoWindow = true,
                            UseShellExecute = false,
                            RedirectStandardOutput = true
                        };
                        using (Process p = Process.Start(psi)) {
                            p.WaitForExit();
                            return p.ExitCode == 0;
                        }
                    } catch { return false; }
                });

                if (success) {
                    _txtStatusLog.Text = "Discord restaurado para o original com sucesso!";
                    _discordInstalled = false;
                    UpdateDiscordVisual();
                    MessageBox.Show(
                        "O Discord foi restaurado para a versao padrao original com sucesso.",
                        "Discord Restaurado",
                        MessageBoxButton.OK,
                        MessageBoxImage.Information
                    );
                } else {
                    _txtStatusLog.Text = "Falha ao restaurar o Discord.";
                }
            }

            _btnToggleDiscord.IsEnabled = true;
            RefreshDiscordStatus();
        }

        private static void HandleRestartDiscord() {
            _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] Reiniciando Discord para destravar camera e conexao...";
            Task.Run(() => {
                try {
                    try {
                        ProcessStartInfo kPsi = new ProcessStartInfo {
                            FileName = "taskkill.exe",
                            Arguments = "/F /IM Discord.exe /IM DiscordPTB.exe /IM DiscordCanary.exe",
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        using (Process kp = Process.Start(kPsi)) {
                            if (kp != null) kp.WaitForExit(1000);
                        }
                    } catch { }

                    foreach (var p in Process.GetProcessesByName("Discord")) {
                        try { p.Kill(); } catch { }
                    }
                    foreach (var p in Process.GetProcessesByName("DiscordPTB")) {
                        try { p.Kill(); } catch { }
                    }
                    foreach (var p in Process.GetProcessesByName("DiscordCanary")) {
                        try { p.Kill(); } catch { }
                    }
                    System.Threading.Thread.Sleep(700);

                    string coreDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "core");
                    string startTor = Path.Combine(coreDir, "start_tor.ps1");
                    if (File.Exists(startTor)) {
                        ProcessStartInfo torPsi = new ProcessStartInfo {
                            FileName = "powershell.exe",
                            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + startTor + "\"",
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        using (Process tp = Process.Start(torPsi)) {
                            if (tp != null) tp.WaitForExit(4000);
                        }
                    }

                    string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                    string discordDir = Path.Combine(localApp, "Discord");
                    if (Directory.Exists(discordDir)) {
                        var dirs = new DirectoryInfo(discordDir).GetDirectories("app-*");
                        Array.Sort(dirs, (a, b) => string.Compare(b.Name, a.Name, StringComparison.OrdinalIgnoreCase));
                        if (dirs.Length > 0) {
                            string exe = Path.Combine(dirs[0].FullName, "Discord.exe");
                            if (File.Exists(exe)) {
                                Process.Start(new ProcessStartInfo { FileName = exe });
                            }
                        }
                    }

                    if (_window != null) {
                        _window.Dispatcher.Invoke(() => {
                            _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] Discord reiniciado com sucesso! Camera liberada.";
                        });
                    }
                } catch (Exception ex) {
                    if (_window != null) {
                        _window.Dispatcher.Invoke(() => {
                            _txtStatusLog.Text = "Erro ao reiniciar Discord: " + ex.Message;
                        });
                    }
                }
            });
        }

        private static void EnsureTorAndVpnBootReady() {
            try {
                string appDir = AppDomain.CurrentDomain.BaseDirectory;
                string coreDir = Path.Combine(appDir, "core");

                // 1. Iniciar Tor se nao estiver escutando na porta 9060
                bool torReady = false;
                try {
                    using (var client = new System.Net.Sockets.TcpClient()) {
                        var task = client.ConnectAsync("127.0.0.1", 9060);
                        if (task.Wait(400) && client.Connected) {
                            torReady = true;
                        }
                    }
                } catch { }

                if (!torReady) {
                    string startTor = Path.Combine(coreDir, "start_tor.ps1");
                    if (File.Exists(startTor)) {
                        ProcessStartInfo torPsi = new ProcessStartInfo {
                            FileName = "powershell.exe",
                            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + startTor + "\"",
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        using (Process tp = Process.Start(torPsi)) {
                            if (tp != null) tp.WaitForExit(3500);
                        }
                    }
                }

                // 2. Iniciar GoodbyeDPI (Bypass DPI de video/camera)
                if (!IsGdpiRunning()) {
                    StartGdpi();
                }

                // 3. Registrar tarefa no Agendador do Windows para iniciar com privilegios elevados no Logon
                string vpndsExe = Process.GetCurrentProcess().MainModule.FileName;
                if (!string.IsNullOrEmpty(vpndsExe) && File.Exists(vpndsExe)) {
                    ProcessStartInfo schPsi = new ProcessStartInfo {
                        FileName = "schtasks.exe",
                        Arguments = "/create /tn \"VPNDS_AutoStart\" /tr \"\\\"" + vpndsExe + "\\\" --minimized\" /sc onlogon /rl highest /f",
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    using (Process sp = Process.Start(schPsi)) {
                        if (sp != null) sp.WaitForExit(1500);
                    }
                }
            } catch { }
        }

        // ================= RESETAR IP (DHCP + DNS + ROTAS) =================
        private static async void HandleResetIp() {
            if (_btnResetIp == null) return;
            _btnResetIp.IsEnabled = false;
            _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] Renovando IP e restabelecendo rotas de rede...";

            string result = await Task.Run(() => {
                try {
                    // 1. Release & renew IP via DHCP
                    ProcessStartInfo psi = new ProcessStartInfo {
                        FileName = "cmd.exe",
                        Arguments = "/c ipconfig /release & ipconfig /renew & ipconfig /flushdns & arp -d *",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    using (Process p = Process.Start(psi)) {
                        if (p != null) p.WaitForExit(12000);
                    }

                    // 2. If Tor is running in background, restart it to establish a brand new exit IP circuit
                    string coreDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "core");
                    string startTor = Path.Combine(coreDir, "start_tor.ps1");
                    if (File.Exists(startTor)) {
                        ProcessStartInfo torPsi = new ProcessStartInfo {
                            FileName = "powershell.exe",
                            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + startTor + "\"",
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        using (Process tp = Process.Start(torPsi)) {
                            if (tp != null) tp.WaitForExit(6000);
                        }
                    }

                    // 3. Query current active local IPv4
                    string currentIp = "";
                    foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces()) {
                        if (ni.OperationalStatus == OperationalStatus.Up && 
                            ni.NetworkInterfaceType != NetworkInterfaceType.Loopback && 
                            !ni.Description.ToLower().Contains("tailscale") &&
                            !ni.Description.ToLower().Contains("virtual")) {
                            IPInterfaceProperties ipProps = ni.GetIPProperties();
                            foreach (UnicastIPAddressInformation u in ipProps.UnicastAddresses) {
                                if (u.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) {
                                    currentIp = u.Address.ToString();
                                    break;
                                }
                            }
                            if (!string.IsNullOrEmpty(currentIp)) break;
                        }
                    }

                    return string.IsNullOrEmpty(currentIp) ? "Conectado" : currentIp;
                } catch (Exception ex) {
                    return "Erro: " + ex.Message;
                }
            });

            _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] IP Resetado com Sucesso! IP Local: " + result + " • Cache DNS limpo.";
            _btnResetIp.IsEnabled = true;
            RefreshStatus();

            MessageBox.Show(
                "IP e Rotas de Rede Resetados com Sucesso!\n\n" +
                "• Novo IP Local: " + result + "\n" +
                "• Cache de Resolucao DNS: 100% Liberado\n" +
                "• Tabela de Rotas e ARP: Atualizada\n" +
                "• Circuito Externo: Renovado\n\n" +
                "Sua conexao foi restabelecida com nova identidade de rede!",
                "IP Resetado • VPNDS",
                MessageBoxButton.OK,
                MessageBoxImage.Information
            );
        }

        // ================= DNS CONTROLLER (IPv4 + IPv6) =================
        private static List<string> GetActiveAdapterNames() {
            List<string> list = new List<string>();
            try {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces()) {
                    if (ni.OperationalStatus == OperationalStatus.Up && 
                        ni.NetworkInterfaceType != NetworkInterfaceType.Loopback && 
                        !ni.Description.ToLower().Contains("tailscale") &&
                        !ni.Description.ToLower().Contains("virtual") &&
                        !ni.Description.ToLower().Contains("pseudo")) {
                        list.Add(ni.Name);
                    }
                }
            } catch { }
            if (list.Count == 0) { list.Add("Ethernet"); }
            return list;
        }

        private static List<string> GetCurrentDnsAddresses() {
            List<string> list = new List<string>();
            try {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces()) {
                    if (ni.OperationalStatus == OperationalStatus.Up && 
                        ni.NetworkInterfaceType != NetworkInterfaceType.Loopback && 
                        !ni.Description.ToLower().Contains("tailscale") &&
                        !ni.Description.ToLower().Contains("virtual")) {
                        IPInterfaceProperties prop = ni.GetIPProperties();
                        foreach (IPAddress ip in prop.DnsAddresses) {
                            string s = ip.ToString();
                            if (!list.Contains(s)) { list.Add(s); }
                        }
                    }
                }
            } catch { }
            return list;
        }

        private static void RefreshStatus() {
            List<string> adapters = GetActiveAdapterNames();
            _statusAdapter.Text = "Placa de Rede: " + string.Join(", ", adapters.ToArray());

            List<string> currentDns = GetCurrentDnsAddresses();
            string orig = _originalDns.Trim();

            bool isOrig = currentDns.Contains(orig);
            DnsProvider activeProv = null;

            foreach (var p in _providers) {
                if (currentDns.Contains(p.Primary)) {
                    activeProv = p;
                    break;
                }
            }

            foreach (var p in _providers) {
                bool isInUse = (activeProv == p);
                p.StatusInUseBadge.Visibility = isInUse ? Visibility.Visible : Visibility.Collapsed;
                if (isInUse) {
                    p.CardBorder.BorderBrush = (Brush)_bc.ConvertFromString("#10B981");
                    p.CardBorder.Background = (Brush)_bc.ConvertFromString("#141F18");

                    if (p.ActionText != null) {
                        p.ActionText.Text = "DESATIVAR";
                        p.ActionText.Foreground = (Brush)_bc.ConvertFromString("#F87171");
                    }
                    if (p.ActionBorder != null) {
                        p.ActionBorder.Background = (Brush)_bc.ConvertFromString("#27272A");
                        p.ActionBorder.BorderBrush = (Brush)_bc.ConvertFromString("#EF4444");
                        p.ActionBorder.BorderThickness = new Thickness(1);
                    }
                } else {
                    p.CardBorder.BorderBrush = (Brush)_bc.ConvertFromString("#27272A");
                    p.CardBorder.Background = (Brush)_bc.ConvertFromString("#121216");

                    if (p.ActionText != null) {
                        p.ActionText.Text = "ATIVAR";
                        p.ActionText.Foreground = (Brush)_bc.ConvertFromString("#09090B");
                    }
                    if (p.ActionBorder != null) {
                        p.ActionBorder.Background = (Brush)_bc.ConvertFromString("#FFFFFF");
                        p.ActionBorder.BorderBrush = Brushes.Transparent;
                        p.ActionBorder.BorderThickness = new Thickness(0);
                    }
                }
            }

            bool vpnActive = IsGdpiRunning();

            if (vpnActive) {
                _statusDot.Fill = (Brush)_bc.ConvertFromString("#10B981");
                _statusTitle.Text = "VPN LEVE ATIVA • GOODBYEDPI (1MS)";
                _statusValue.Text = "Bypass DPI Ativo (Discord liberado)" + (activeProv != null ? " + " + activeProv.Name : "");
                _statusBadge.Background = (Brush)_bc.ConvertFromString("#142E1F");
                _statusBadgeText.Text = "VPN LIGADA";
                _statusBadgeText.Foreground = (Brush)_bc.ConvertFromString("#34D399");
                _statusCard.BorderBrush = (Brush)_bc.ConvertFromString("#10B981");

                _btnRestoreMaster.Visibility = Visibility.Visible;
            } else if (isOrig && activeProv == null) {
                _statusDot.Fill = (Brush)_bc.ConvertFromString("#FFFFFF");
                _statusTitle.Text = "DNS ORIGINAL ATIVO (VPN DESLIGADA)";
                _statusValue.Text = "DNS Original: " + orig;
                _statusBadge.Background = (Brush)_bc.ConvertFromString("#1C1C22");
                _statusBadgeText.Text = "MEU PADRAO";
                _statusBadgeText.Foreground = (Brush)_bc.ConvertFromString("#E4E4E7");
                _statusCard.BorderBrush = (Brush)_bc.ConvertFromString("#3F3F46");

                _btnRestoreMaster.Visibility = Visibility.Collapsed;
            } else if (activeProv != null) {
                _statusDot.Fill = (Brush)_bc.ConvertFromString("#10B981");
                _statusTitle.Text = "DNS RAPIDO ATIVO • " + activeProv.Name.ToUpper();
                _statusValue.Text = activeProv.Name + " (" + activeProv.Primary + " + IPv6)";
                _statusBadge.Background = (Brush)_bc.ConvertFromString("#142E1F");
                _statusBadgeText.Text = "DNS LIGADO";
                _statusBadgeText.Foreground = (Brush)_bc.ConvertFromString("#34D399");
                _statusCard.BorderBrush = (Brush)_bc.ConvertFromString("#10B981");

                _btnRestoreMaster.Visibility = Visibility.Visible;
            } else {
                _statusDot.Fill = (Brush)_bc.ConvertFromString("#F59E0B");
                _statusTitle.Text = "DNS PERSONALIZADO";
                _statusValue.Text = currentDns.Count > 0 ? string.Join(", ", currentDns.ToArray()) : "DHCP";
                _statusBadge.Background = (Brush)_bc.ConvertFromString("#2A2012");
                _statusBadgeText.Text = "OUTRO";
                _statusBadgeText.Foreground = (Brush)_bc.ConvertFromString("#FBBF24");
                _statusCard.BorderBrush = (Brush)_bc.ConvertFromString("#78350F");

                _btnRestoreMaster.Visibility = Visibility.Visible;
            }
        }

        private static void ToggleProvider(DnsProvider prov) {
            List<string> currentDns = GetCurrentDnsAddresses();
            if (currentDns.Contains(prov.Primary)) {
                // Se ja esta ativo, o clique atua como DESATIVAR (volta ao DNS original)
                RestoreOriginal();
            } else {
                // Caso contrario, ativa
                ActivateProvider(prov);
            }
        }

        private static void ExecuteDnsCommand(string[] ips, string label) {
            try {
                string ipList = "'" + string.Join("','", ips) + "'";
                string psCommand = "$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN|Hyper-V|vEthernet' }; foreach ($a in $adapters) { Set-DnsClientServerAddress -InterfaceAlias $a.Name -ServerAddresses (" + ipList + ") }; Clear-DnsClientCache";

                ProcessStartInfo psi = new ProcessStartInfo {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + psCommand + "\"",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                using (Process proc = Process.Start(psi)) {
                    if (proc != null) { proc.WaitForExit(); }
                }

                _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + label + " aplicado (IPv4 + IPv6 sem vazamento)! Cache liberado.";
                RefreshStatus();
            } catch (Exception ex) {
                MessageBox.Show("Erro ao aplicar DNS:\n" + ex.Message, "Erro", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private static void ActivateProvider(DnsProvider prov) {
            List<string> ips = new List<string> { prov.Primary };
            if (!string.IsNullOrEmpty(prov.Secondary)) { ips.Add(prov.Secondary); }
            if (!string.IsNullOrEmpty(prov.Ipv6Primary)) { ips.Add(prov.Ipv6Primary); }
            if (!string.IsNullOrEmpty(prov.Ipv6Secondary)) { ips.Add(prov.Ipv6Secondary); }
            ExecuteDnsCommand(ips.ToArray(), prov.Name);
        }

        private static void RestoreOriginal() {
            StopGdpi();

            string orig = _originalDns.Trim();
            if (string.IsNullOrEmpty(orig)) { orig = "192.168.0.113"; }
            
            // Restaura o IPv4 do usuario e usa Cloudflare IPv6 para impedir que o IPv6 da operadora volte a bloquear sites
            ExecuteDnsCommand(new string[] { orig, "2606:4700:4700::1111" }, "DNS Original (" + orig + ")");
            UpdateVpnStatus();
            RefreshStatus();
        }

        private static async Task PingAllProviders() {
            _btnPingAll.IsEnabled = false;
            _txtStatusLog.Text = "Medindo tempo de resposta (ping) dos servidores...";

            foreach (var p in _providers) {
                p.PingTextBlock.Text = "Medindo...";
                p.PingTextBlock.Foreground = (Brush)_bc.ConvertFromString("#FBBF24");
            }

            foreach (var prov in _providers) {
                try {
                    long rtt = await Task.Run(() => {
                        using (Ping ping = new Ping()) {
                            PingReply reply = ping.Send(prov.Primary, 1200);
                            if (reply.Status == IPStatus.Success) {
                                return reply.RoundtripTime;
                            }
                        }
                        return -1;
                    });

                    if (rtt >= 0) {
                        prov.PingTextBlock.Text = rtt + " ms";
                        if (rtt < 30) {
                            prov.PingTextBlock.Foreground = (Brush)_bc.ConvertFromString("#10B981");
                        } else if (rtt < 60) {
                            prov.PingTextBlock.Foreground = (Brush)_bc.ConvertFromString("#38BDF8");
                        } else {
                            prov.PingTextBlock.Foreground = (Brush)_bc.ConvertFromString("#F59E0B");
                        }
                    } else {
                        prov.PingTextBlock.Text = "Sem resp.";
                        prov.PingTextBlock.Foreground = (Brush)_bc.ConvertFromString("#EF4444");
                    }
                } catch {
                    prov.PingTextBlock.Text = "Erro";
                    prov.PingTextBlock.Foreground = (Brush)_bc.ConvertFromString("#EF4444");
                }
            }

            _txtStatusLog.Text = "Pings concluidos com sucesso!";
            _btnPingAll.IsEnabled = true;
        }

        // ================= SISTEMA DE ATUALIZACAO AUTOMATICA (AUTO-UPDATER) =================
        private static string ExtractJsonString(string json, string key) {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key)) return null;
            try {
                int idx = json.IndexOf("\"" + key + "\"");
                if (idx == -1) return null;
                int colon = json.IndexOf(":", idx);
                if (colon == -1) return null;
                int quote1 = json.IndexOf("\"", colon);
                if (quote1 == -1) return null;

                int quote2 = quote1 + 1;
                while (quote2 < json.Length) {
                    if (json[quote2] == '\"' && json[quote2 - 1] != '\\') {
                        break;
                    }
                    quote2++;
                }
                if (quote2 >= json.Length) return null;

                string val = json.Substring(quote1 + 1, quote2 - quote1 - 1);
                return val.Replace("\\\"", "\"").Replace("\\n", "\n").Replace("\\r", "");
            } catch {
                return null;
            }
        }

        private static bool IsNewerVersion(string remoteVer, string currentVer) {
            if (string.IsNullOrEmpty(remoteVer)) return false;
            if (string.IsNullOrEmpty(currentVer)) return true;
            try {
                string[] rParts = remoteVer.Trim().TrimStart('v', 'V').Split('.');
                string[] cParts = currentVer.Trim().TrimStart('v', 'V').Split('.');
                int maxLen = Math.Max(rParts.Length, cParts.Length);
                for (int i = 0; i < maxLen; i++) {
                    int rVal = i < rParts.Length ? int.Parse(rParts[i]) : 0;
                    int cVal = i < cParts.Length ? int.Parse(cParts[i]) : 0;
                    if (rVal > cVal) return true;
                    if (rVal < cVal) return false;
                }
                return false;
            } catch {
                return string.Compare(remoteVer, currentVer, StringComparison.OrdinalIgnoreCase) > 0;
            }
        }

        private static void CheckForUpdates(bool userInitiated) {
            Task.Run(() => {
                try {
                    ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;

                    string url = UPDATE_CHECK_URL + "?t=" + DateTime.UtcNow.Ticks;
                    string json = null;

                    using (WebClient wc = new WebClient()) {
                        wc.Headers.Add("User-Agent", "VPNDS-AutoUpdater/" + CURRENT_VERSION);
                        wc.Headers.Add("Cache-Control", "no-cache");
                        json = wc.DownloadString(url);
                    }

                    if (string.IsNullOrEmpty(json)) {
                        if (userInitiated) {
                            _window.Dispatcher.Invoke(() => {
                                MessageBox.Show("Não foi possível obter informações de atualização.\nVerifique sua conexão com a internet.", "VPNDS Atualizações", MessageBoxButton.OK, MessageBoxImage.Warning);
                            });
                        }
                        return;
                    }

                    string ver = ExtractJsonString(json, "version");
                    string relDate = ExtractJsonString(json, "releaseDate");
                    string title = ExtractJsonString(json, "title");
                    string changelog = ExtractJsonString(json, "changelog");
                    string downloadUrl = ExtractJsonString(json, "downloadUrl");
                    string packageUrl = ExtractJsonString(json, "packageUrl");

                    if (!string.IsNullOrEmpty(ver) && IsNewerVersion(ver, CURRENT_VERSION)) {
                        _latestUpdate = new UpdateInfo {
                            Version = ver,
                            ReleaseDate = relDate,
                            Title = title ?? ("VPNDS v" + ver),
                            Changelog = changelog ?? "Melhorias de desempenho e correções.",
                            DownloadUrl = downloadUrl,
                            PackageUrl = packageUrl
                        };

                        _window.Dispatcher.Invoke(() => {
                            _txtUpdateVersion.Text = "v" + ver;
                            string descText = !string.IsNullOrEmpty(title) ? title : "Nova versao disponivel com melhorias!";
                            if (descText.Length > 60) {
                                descText = descText.Substring(0, 57) + "...";
                            }
                            _txtUpdateDesc.Text = descText;
                            _updateCard.Visibility = Visibility.Visible;
                            _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] Nova versão v" + ver + " disponível no GitHub!";
                        });
                    } else if (userInitiated) {
                        _window.Dispatcher.Invoke(() => {
                            MessageBox.Show("Você já está usando a versão mais recente do VPNDS (v" + CURRENT_VERSION + ")!\n\nNenhuma atualização necessária.", "VPNDS Atualizado", MessageBoxButton.OK, MessageBoxImage.Information);
                            _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] VPNDS está atualizado (v" + CURRENT_VERSION + ").";
                        });
                    }
                } catch (Exception ex) {
                    if (userInitiated) {
                        _window.Dispatcher.Invoke(() => {
                            MessageBox.Show("Erro ao verificar atualizações:\n" + ex.Message, "Aviso", MessageBoxButton.OK, MessageBoxImage.Warning);
                        });
                    }
                }
            });
        }

        private static void ShowChangelog() {
            if (_latestUpdate == null) {
                MessageBox.Show("Nenhuma atualização pendente.", "Novidades", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            string msg = "VPNDS - " + _latestUpdate.Title + "\n\n" +
                         "Versão: v" + _latestUpdate.Version + "\n" +
                         "Data: " + (_latestUpdate.ReleaseDate ?? "Recente") + "\n\n" +
                         "Novidades e Melhorias:\n" +
                         _latestUpdate.Changelog + "\n\n" +
                         "Deseja atualizar agora?";
            MessageBoxResult res = MessageBox.Show(msg, "Novidades do VPNDS v" + _latestUpdate.Version, MessageBoxButton.YesNo, MessageBoxImage.Information);
            if (res == MessageBoxResult.Yes) {
                ExecuteAutoUpdate();
            }
        }

        private static async void ExecuteAutoUpdate() {
            if (_latestUpdate == null || _isUpdating) return;
            _isUpdating = true;

            try {
                _btnApplyUpdate.IsEnabled = false;
                _borderBtnApply = (Border)_btnApplyUpdate.Template.FindName("borderBtnApply", _btnApplyUpdate);
                _txtBtnApply = (TextBlock)_btnApplyUpdate.Template.FindName("txtBtnApply", _btnApplyUpdate);
                if (_txtBtnApply != null) { _txtBtnApply.Text = "BAIXANDO..."; }
                if (_borderBtnApply != null) { _borderBtnApply.Background = (Brush)_bc.ConvertFromString("#1E3A8A"); }

                _txtUpdateProgress.Visibility = Visibility.Visible;
                _txtUpdateProgress.Text = "Conectando ao GitHub para baixar v" + _latestUpdate.Version + "...";
                _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] Baixando atualização oficial do GitHub...";

                string downloadUrl = !string.IsNullOrEmpty(_latestUpdate.PackageUrl) ? _latestUpdate.PackageUrl : _latestUpdate.DownloadUrl;
                if (string.IsNullOrEmpty(downloadUrl)) {
                    downloadUrl = "https://raw.githubusercontent.com/liljinbel/VPNDS/main/VPNDS_Instalador.zip";
                }

                bool isZip = downloadUrl.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);
                string tempDir = Path.GetTempPath();
                string tempFile = Path.Combine(tempDir, isZip ? "vpnds_update.zip" : "VPNDS_new.exe");

                if (File.Exists(tempFile)) {
                    try { File.Delete(tempFile); } catch { }
                }

                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;

                using (WebClient wc = new WebClient()) {
                    wc.Headers.Add("User-Agent", "VPNDS-AutoUpdater/" + CURRENT_VERSION);
                    wc.DownloadProgressChanged += (s, e) => {
                        _window.Dispatcher.Invoke(() => {
                            double mbRec = e.BytesReceived / 1048576.0;
                            double mbTotal = e.TotalBytesToReceive / 1048576.0;
                            if (mbTotal > 0) {
                                _txtUpdateProgress.Text = string.Format("Baixando: {0}% ({1:0.0} MB de {2:0.0} MB)...", e.ProgressPercentage, mbRec, mbTotal);
                            } else {
                                _txtUpdateProgress.Text = string.Format("Baixando: {0:0.0} MB recebidos...", mbRec);
                            }
                        });
                    };

                    await wc.DownloadFileTaskAsync(new Uri(downloadUrl), tempFile);
                }

                _txtUpdateProgress.Text = "Download concluído! Aplicando atualização...";
                _txtStatusLog.Text = "[" + DateTime.Now.ToString("HH:mm:ss") + "] Atualização pronta! Reiniciando VPNDS...";

                string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                string updaterBat = Path.Combine(tempDir, "vpnds_updater.bat");

                StringBuilder sb = new StringBuilder();
                sb.AppendLine("@echo off");
                sb.AppendLine("title Atualizador VPNDS");
                sb.AppendLine("chcp 65001 >nul");
                sb.AppendLine("echo ===================================================================");
                sb.AppendLine("echo               ATUALIZANDO VPNDS AUTOMATICAMENTE");
                sb.AppendLine("echo ===================================================================");
                sb.AppendLine("echo.");
                sb.AppendLine("echo [1/3] Fechando versao anterior em execucao...");
                sb.AppendLine("timeout /t 1 /nobreak >nul");
                sb.AppendLine("taskkill /F /IM VPNDS.exe >nul 2>&1");
                sb.AppendLine("taskkill /F /IM VPN_de_DNS.exe >nul 2>&1");
                sb.AppendLine("timeout /t 1 /nobreak >nul");
                sb.AppendLine();
                sb.AppendLine("set \"APP_DIR=" + appDir + "\"");
                sb.AppendLine("set \"EXTRACT_DIR=%TEMP%\\vpnds_extract\"");
                sb.AppendLine();
                if (isZip) {
                    sb.AppendLine("echo [2/3] Extraindo pacote atualizado...");
                    sb.AppendLine("if exist \"%EXTRACT_DIR%\" rd /s /q \"%EXTRACT_DIR%\" >nul 2>&1");
                    sb.AppendLine("mkdir \"%EXTRACT_DIR%\" >nul 2>&1");
                    sb.AppendLine("tar -xf \"" + tempFile + "\" -C \"%EXTRACT_DIR%\" >nul 2>&1");
                    sb.AppendLine("if not exist \"%EXTRACT_DIR%\\VPNDS.exe\" (");
                    sb.AppendLine("    if not exist \"%EXTRACT_DIR%\\VPNDS_Instalador\\VPNDS.exe\" (");
                    sb.AppendLine("        powershell -NoProfile -ExecutionPolicy Bypass -Command \"Expand-Archive -Path '" + tempFile + "' -DestinationPath '%EXTRACT_DIR%' -Force\"");
                    sb.AppendLine("    )");
                    sb.AppendLine(")");
                    sb.AppendLine();
                    sb.AppendLine("echo [3/3] Copiando novos arquivos para o aplicativo...");
                    sb.AppendLine("if exist \"%EXTRACT_DIR%\\VPNDS_Instalador\\VPNDS.exe\" (");
                    sb.AppendLine("    xcopy /e /y /q \"%EXTRACT_DIR%\\VPNDS_Instalador\\*\" \"%APP_DIR%\\\" >nul 2>&1");
                    sb.AppendLine(") else (");
                    sb.AppendLine("    xcopy /e /y /q \"%EXTRACT_DIR%\\*\" \"%APP_DIR%\\\" >nul 2>&1");
                    sb.AppendLine(")");
                    sb.AppendLine("del /f /q \"" + tempFile + "\" >nul 2>&1");
                    sb.AppendLine("rd /s /q \"%EXTRACT_DIR%\" >nul 2>&1");
                } else {
                    sb.AppendLine("echo [2/3] Atualizando executavel principal...");
                    sb.AppendLine("copy /y \"" + tempFile + "\" \"%APP_DIR%\\VPNDS.exe\" >nul 2>&1");
                    sb.AppendLine("del /f /q \"" + tempFile + "\" >nul 2>&1");
                }
                sb.AppendLine();
                sb.AppendLine("echo.");
                sb.AppendLine("echo [SUCESSO] Atualizacao v" + _latestUpdate.Version + " concluida com sucesso!");
                sb.AppendLine("echo Reiniciando o VPNDS agora...");
                sb.AppendLine("timeout /t 1 /nobreak >nul");
                sb.AppendLine("start \"\" \"%APP_DIR%\\VPNDS.exe\"");
                sb.AppendLine("(goto) 2>nul & del \"%~f0\"");
                sb.AppendLine("exit");

                File.WriteAllText(updaterBat, sb.ToString(), Encoding.Default);

                ProcessStartInfo psi = new ProcessStartInfo {
                    FileName = "cmd.exe",
                    Arguments = "/c \"" + updaterBat + "\"",
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Normal
                };
                Process.Start(psi);

                Environment.Exit(0);
            } catch (Exception ex) {
                _isUpdating = false;
                _btnApplyUpdate.IsEnabled = true;
                if (_txtBtnApply != null) { _txtBtnApply.Text = "TENTAR NOVAMENTE"; }
                _txtUpdateProgress.Text = "Erro: " + ex.Message;
                MessageBox.Show("Erro ao baixar e aplicar atualização:\n" + ex.Message, "Erro no Auto-Update", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
    }
}
