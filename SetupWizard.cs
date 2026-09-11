using System;
using System.IO;
using System.Xml;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Markup;
using Microsoft.Win32;

namespace VpndsInstaller {
    public class Program {
        private static Window _window;
        private static BrushConverter _bc = new BrushConverter();

        // Pages
        private static Grid _page1Welcome;
        private static Grid _page2Destination;
        private static Grid _page3Options;
        private static Grid _page4Progress;
        private static Grid _page5Finish;

        // Navigation
        private static Button _btnBack;
        private static Button _btnNext;
        private static Button _btnCancel;

        // Step Indicators
        private static TextBlock _lblStep1;
        private static TextBlock _lblStep2;
        private static TextBlock _lblStep3;
        private static TextBlock _lblStep4;
        private static TextBlock _lblStep5;

        // Inputs
        private static TextBox _txtInstallPath;
        private static CheckBox _chkAutostart;
        private static CheckBox _chkDesktopShortcut;
        private static CheckBox _chkStartMenu;
        private static CheckBox _chkDiscordBypass;
        private static CheckBox _chkLaunchNow;

        // Progress elements
        private static ProgressBar _progressBar;
        private static TextBlock _lblProgressStatus;
        private static TextBlock _lblProgressDetails;

        private static int _currentStep = 1;
        private static string _selectedPath = "";

        [STAThread]
        public static void Main() {
            try {
                BuildAndShowGui();
            } catch (Exception ex) {
                MessageBox.Show("Erro ao abrir assistente de instalacao:\n" + ex.Message, "Erro", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private static void BuildAndShowGui() {
            string defaultPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "VPNDS"
            );
            _selectedPath = defaultPath;

            string xaml = @"
<Window xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
        xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml""
        Title=""Instalador do VPNDS"" Height=""520"" Width=""680""
        WindowStartupLocation=""CenterScreen"" ResizeMode=""NoResize""
        Background=""#09090B"" Foreground=""#F4F4F5"" FontFamily=""Segoe UI"">
    <Window.Resources>
        <Style TargetType=""Button"">
            <Setter Property=""Cursor"" Value=""Hand""/>
            <Setter Property=""FontWeight"" Value=""SemiBold""/>
            <Setter Property=""BorderThickness"" Value=""0""/>
        </Style>
        <Style TargetType=""CheckBox"">
            <Setter Property=""Foreground"" Value=""#E4E4E7""/>
            <Setter Property=""FontSize"" Value=""12""/>
            <Setter Property=""Cursor"" Value=""Hand""/>
            <Setter Property=""Margin"" Value=""0,6,0,6""/>
        </Style>
    </Window.Resources>

    <Grid>
        <Grid.ColumnDefinitions>
            <ColumnDefinition Width=""200""/> <!-- Sidebar -->
            <ColumnDefinition Width=""*""/>   <!-- Main Wizard Area -->
        </Grid.ColumnDefinitions>

        <!-- SIDEBAR -->
        <Border Grid.Column=""0"" Background=""#111114"" BorderBrush=""#27272A"" BorderThickness=""0,0,1,0"">
            <Grid Margin=""20,24,20,24"">
                <Grid.RowDefinitions>
                    <RowDefinition Height=""Auto""/>
                    <RowDefinition Height=""*""/>
                    <RowDefinition Height=""Auto""/>
                </Grid.RowDefinitions>

                <!-- Branding -->
                <StackPanel Grid.Row=""0"">
                    <Border Background=""#18181C"" BorderBrush=""#27272A"" BorderThickness=""1.2"" CornerRadius=""10"" Width=""48"" Height=""48"" HorizontalAlignment=""Left"">
                        <TextBlock Text=""VPNDS"" FontWeight=""Black"" FontSize=""11"" Foreground=""#FFFFFF"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                    </Border>
                    <TextBlock Text=""VPNDS"" FontSize=""18"" FontWeight=""Black"" Foreground=""#FFFFFF"" Margin=""0,12,0,0""/>
                    <TextBlock Text=""Assistente de Instalacao"" FontSize=""10"" Foreground=""#71717A"" Margin=""0,2,0,0""/>
                </StackPanel>

                <!-- Steps -->
                <StackPanel Grid.Row=""1"" VerticalAlignment=""Center"">
                    <TextBlock Name=""LblStep1"" Text=""1. Boas-vindas"" FontSize=""11.5"" FontWeight=""Bold"" Foreground=""#FFFFFF"" Margin=""0,8""/>
                    <TextBlock Name=""LblStep2"" Text=""2. Destino"" FontSize=""11.5"" FontWeight=""SemiBold"" Foreground=""#52525B"" Margin=""0,8""/>
                    <TextBlock Name=""LblStep3"" Text=""3. Configuracoes"" FontSize=""11.5"" FontWeight=""SemiBold"" Foreground=""#52525B"" Margin=""0,8""/>
                    <TextBlock Name=""LblStep4"" Text=""4. Instalacao"" FontSize=""11.5"" FontWeight=""SemiBold"" Foreground=""#52525B"" Margin=""0,8""/>
                    <TextBlock Name=""LblStep5"" Text=""5. Conclusao"" FontSize=""11.5"" FontWeight=""SemiBold"" Foreground=""#52525B"" Margin=""0,8""/>
                </StackPanel>

                <!-- Version Info -->
                <TextBlock Grid.Row=""2"" Text=""v2.0 • Ultra Frosted Glass"" FontSize=""9.5"" Foreground=""#3F3F46""/>
            </Grid>
        </Border>

        <!-- MAIN AREA -->
        <Grid Grid.Column=""1"">
            <Grid.RowDefinitions>
                <RowDefinition Height=""*""/>
                <RowDefinition Height=""Auto""/>
            </Grid.RowDefinitions>

            <!-- PAGES CONTAINER -->
            <Grid Grid.Row=""0"" Margin=""28,24,28,16"">
                <!-- PAGE 1: WELCOME -->
                <Grid Name=""Page1Welcome"" Visibility=""Visible"">
                    <StackPanel VerticalAlignment=""Center"">
                        <Border Background=""#141418"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""8"" Padding=""10,4"" HorizontalAlignment=""Left"" Margin=""0,0,0,12"">
                            <TextBlock Text=""DESEMPENHO MAXIMO • 1MS"" FontSize=""9"" FontWeight=""Bold"" Foreground=""#A1A1AA""/>
                        </Border>
                        <TextBlock Text=""Instalacao do VPNDS"" FontSize=""22"" FontWeight=""Black"" Foreground=""#FFFFFF""/>
                        <TextBlock Text=""Este assistente ira instalar o VPNDS de forma permanente e integrada ao Windows no seu computador."" 
                                   TextWrapping=""Wrap"" FontSize=""12"" Foreground=""#A1A1AA"" Margin=""0,8,0,18""/>

                        <Border Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""10"" Padding=""14"">
                            <StackPanel>
                                <TextBlock Text=""Recursos que serao configurados: "" FontSize=""11.5"" FontWeight=""Bold"" Foreground=""#FFFFFF"" Margin=""0,0,0,8""/>
                                <TextBlock Text=""• Bypass Inteligente de Restricoes com GoodbyeDPI"" FontSize=""10.5"" Foreground=""#A1A1AA"" Margin=""0,2""/>
                                <TextBlock Text=""• Desbloqueio definitivo de Tela e Camera no Discord (1ms nativo)"" FontSize=""10.5"" Foreground=""#A1A1AA"" Margin=""0,2""/>
                                <TextBlock Text=""• Alternador de DNS Ultra-Rapido (Cloudflare, Google, Quad9)"" FontSize=""10.5"" Foreground=""#A1A1AA"" Margin=""0,2""/>
                                <TextBlock Text=""• Inicializacao com o Windows para conveniencia total"" FontSize=""10.5"" Foreground=""#A1A1AA"" Margin=""0,2""/>
                            </StackPanel>
                        </Border>

                        <TextBlock Text=""Clique em 'Avancar' para continuar."" FontSize=""11"" Foreground=""#71717A"" Margin=""0,16,0,0""/>
                    </StackPanel>
                </Grid>

                <!-- PAGE 2: DESTINATION -->
                <Grid Name=""Page2Destination"" Visibility=""Collapsed"">
                    <StackPanel VerticalAlignment=""Center"">
                        <TextBlock Text=""Selecione a Pasta de Instalacao"" FontSize=""19"" FontWeight=""Bold"" Foreground=""#FFFFFF""/>
                        <TextBlock Text=""O assistente ira instalar o programa na seguinte pasta. Para instalar em outra pasta, clique em 'Procurar'."" 
                                   TextWrapping=""Wrap"" FontSize=""11.5"" Foreground=""#A1A1AA"" Margin=""0,6,0,20""/>

                        <Border Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""10"" Padding=""14"">
                            <StackPanel>
                                <TextBlock Text=""Pasta de Destino:"" FontSize=""10.5"" FontWeight=""SemiBold"" Foreground=""#71717A"" Margin=""0,0,0,6""/>
                                <Grid>
                                    <Grid.ColumnDefinitions>
                                        <ColumnDefinition Width=""*""/>
                                        <ColumnDefinition Width=""Auto""/>
                                    </Grid.ColumnDefinitions>
                                    <TextBox Name=""TxtInstallPath"" Grid.Column=""0"" Height=""34"" Background=""#18181C"" Foreground=""#FFFFFF"" 
                                             BorderBrush=""#27272A"" BorderThickness=""1"" Padding=""8,0"" VerticalContentAlignment=""Center"" 
                                             FontWeight=""SemiBold"" FontSize=""11""/>
                                    <Button Name=""BtnBrowse"" Grid.Column=""1"" Width=""85"" Height=""34"" Margin=""8,0,0,0"">
                                        <Button.Template>
                                            <ControlTemplate TargetType=""Button"">
                                                <Border Name=""b"" Background=""#18181C"" BorderBrush=""#3F3F46"" BorderThickness=""1"" CornerRadius=""6"">
                                                    <TextBlock Text=""Procurar..."" FontSize=""10.5"" FontWeight=""Bold"" Foreground=""#E4E4E7"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                                                </Border>
                                                <ControlTemplate.Triggers>
                                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                                        <Setter TargetName=""b"" Property=""Background"" Value=""#27272A""/>
                                                    </Trigger>
                                                </ControlTemplate.Triggers>
                                            </ControlTemplate>
                                        </Button.Template>
                                    </Button>
                                </Grid>
                            </StackPanel>
                        </Border>

                        <Border Background=""#0E0E11"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""8"" Padding=""10"" Margin=""0,16,0,0"">
                            <StackPanel Orientation=""Horizontal"">
                                <TextBlock Text=""Espaco necessario em disco: "" FontSize=""10.5"" Foreground=""#71717A""/>
                                <TextBlock Text=""~15 MB"" FontSize=""10.5"" FontWeight=""Bold"" Foreground=""#FFFFFF""/>
                            </StackPanel>
                        </Border>
                    </StackPanel>
                </Grid>

                <!-- PAGE 3: OPTIONS -->
                <Grid Name=""Page3Options"" Visibility=""Collapsed"">
                    <StackPanel VerticalAlignment=""Center"">
                        <TextBlock Text=""Tarefas Adicionais"" FontSize=""19"" FontWeight=""Bold"" Foreground=""#FFFFFF""/>
                        <TextBlock Text=""Selecione as acoes adicionais que voce deseja que o assistente execute durante a instalacao:"" 
                                   TextWrapping=""Wrap"" FontSize=""11.5"" Foreground=""#A1A1AA"" Margin=""0,6,0,16""/>

                        <Border Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""10"" Padding=""14"">
                            <StackPanel>
                                <CheckBox Name=""ChkAutostart"" IsChecked=""True"">
                                    <StackPanel Margin=""6,0,0,0"">
                                        <TextBlock Text=""Iniciar automaticamente com o Windows"" FontWeight=""Bold"" Foreground=""#FFFFFF"" FontSize=""12""/>
                                        <TextBlock Text=""O VPNDS iniciara mantendo Discord e conexoes liberadas."" FontSize=""9.5"" Foreground=""#71717A""/>
                                    </StackPanel>
                                </CheckBox>

                                <Separator Background=""#27272A"" Margin=""0,8""/>

                                <CheckBox Name=""ChkDesktopShortcut"" IsChecked=""True"">
                                    <TextBlock Text=""Criar atalho na Area de Trabalho (Desktop)"" FontWeight=""Bold"" Margin=""6,0,0,0""/>
                                </CheckBox>

                                <CheckBox Name=""ChkStartMenu"" IsChecked=""True"">
                                    <TextBlock Text=""Criar atalho no Menu Iniciar"" FontWeight=""Bold"" Margin=""6,0,0,0""/>
                                </CheckBox>

                                <Separator Background=""#27272A"" Margin=""0,8""/>

                                <CheckBox Name=""ChkDiscordBypass"" IsChecked=""True"">
                                    <StackPanel Margin=""6,0,0,0"">
                                        <TextBlock Text=""Implementar agora a VPN de 1ms no Discord"" FontWeight=""Bold"" Foreground=""#FFFFFF"" FontSize=""12""/>
                                        <TextBlock Text=""Aplica o desbloqueio definitivo de compartilhamento de tela e camera."" FontSize=""9.5"" Foreground=""#71717A""/>
                                    </StackPanel>
                                </CheckBox>
                            </StackPanel>
                        </Border>
                    </StackPanel>
                </Grid>

                <!-- PAGE 4: PROGRESS -->
                <Grid Name=""Page4Progress"" Visibility=""Collapsed"">
                    <StackPanel VerticalAlignment=""Center"">
                        <TextBlock Text=""Instalando o VPNDS..."" FontSize=""19"" FontWeight=""Bold"" Foreground=""#FFFFFF""/>
                        <TextBlock Text=""Por favor aguarde enquanto o assistente instala e configura o VPNDS no seu sistema."" 
                                   TextWrapping=""Wrap"" FontSize=""11.5"" Foreground=""#A1A1AA"" Margin=""0,6,0,24""/>

                        <Border Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""10"" Padding=""16"">
                            <StackPanel>
                                <TextBlock Name=""LblProgressStatus"" Text=""Copiando arquivos..."" FontSize=""12"" FontWeight=""Bold"" Foreground=""#FFFFFF"" Margin=""0,0,0,8""/>
                                
                                <ProgressBar Name=""ProgressBar"" Height=""8"" Minimum=""0"" Maximum=""100"" Value=""10"" 
                                             Background=""#18181C"" Foreground=""#FFFFFF"" BorderThickness=""0""/>
                                
                                <TextBlock Name=""LblProgressDetails"" Text=""Preparando instalacao..."" FontSize=""10"" Foreground=""#71717A"" Margin=""0,8,0,0""/>
                            </StackPanel>
                        </Border>
                    </StackPanel>
                </Grid>

                <!-- PAGE 5: FINISH -->
                <Grid Name=""Page5Finish"" Visibility=""Collapsed"">
                    <StackPanel VerticalAlignment=""Center"">
                        <Border Background=""#142E1F"" BorderBrush=""#10B981"" BorderThickness=""1"" CornerRadius=""8"" Width=""42"" Height=""42"" HorizontalAlignment=""Left"" Margin=""0,0,0,12"">
                            <TextBlock Text=""OK"" FontWeight=""Black"" FontSize=""13"" Foreground=""#34D399"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                        </Border>

                        <TextBlock Text=""Instalacao Concluida com Sucesso!"" FontSize=""20"" FontWeight=""Black"" Foreground=""#FFFFFF""/>
                        <TextBlock Text=""O VPNDS foi instalado com exito no seu computador. Todos os modulos de rede e bypass estao prontos para uso."" 
                                   TextWrapping=""Wrap"" FontSize=""12"" Foreground=""#A1A1AA"" Margin=""0,8,0,20""/>

                        <Border Background=""#121216"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""10"" Padding=""14"" Margin=""0,0,0,16"">
                            <StackPanel>
                                <CheckBox Name=""ChkLaunchNow"" IsChecked=""True"">
                                    <TextBlock Text=""Iniciar o VPNDS agora"" FontWeight=""Bold"" Foreground=""#FFFFFF"" Margin=""6,0,0,0""/>
                                </CheckBox>
                            </StackPanel>
                        </Border>

                        <TextBlock Text=""Clique em 'Concluir' para encerrar o assistente."" FontSize=""11"" Foreground=""#71717A""/>
                    </StackPanel>
                </Grid>
            </Grid>

            <!-- BOTTOM NAVIGATION BAR -->
            <Border Grid.Row=""1"" Background=""#111114"" BorderBrush=""#27272A"" BorderThickness=""0,1,0,0"" Padding=""20,12"">
                <Grid>
                    <Grid.ColumnDefinitions>
                        <ColumnDefinition Width=""Auto""/>
                        <ColumnDefinition Width=""*""/>
                        <ColumnDefinition Width=""Auto""/>
                        <ColumnDefinition Width=""Auto""/>
                    </Grid.ColumnDefinitions>

                    <Button Name=""BtnCancel"" Grid.Column=""0"" Height=""32"" Width=""85"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""b"" Background=""#18181C"" BorderBrush=""#27272A"" BorderThickness=""1"" CornerRadius=""6"">
                                    <TextBlock Text=""Cancelar"" FontSize=""11"" FontWeight=""SemiBold"" Foreground=""#A1A1AA"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""b"" Property=""Background"" Value=""#27272A""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>

                    <Button Name=""BtnBack"" Grid.Column=""2"" Height=""32"" Width=""85"" Margin=""0,0,10,0"" Visibility=""Collapsed"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""b"" Background=""#18181C"" BorderBrush=""#3F3F46"" BorderThickness=""1"" CornerRadius=""6"">
                                    <TextBlock Text=""&lt; Voltar"" FontSize=""11"" FontWeight=""Bold"" Foreground=""#E4E4E7"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""b"" Property=""Background"" Value=""#27272A""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>

                    <Button Name=""BtnNext"" Grid.Column=""3"" Height=""32"" Width=""100"">
                        <Button.Template>
                            <ControlTemplate TargetType=""Button"">
                                <Border Name=""b"" Background=""#FFFFFF"" CornerRadius=""6"">
                                    <TextBlock Name=""txt"" Text=""Avancar &gt;"" FontSize=""11"" FontWeight=""Bold"" Foreground=""#09090B"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                                </Border>
                                <ControlTemplate.Triggers>
                                    <Trigger Property=""IsMouseOver"" Value=""True"">
                                        <Setter TargetName=""b"" Property=""Background"" Value=""#E4E4E7""/>
                                    </Trigger>
                                </ControlTemplate.Triggers>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>
                </Grid>
            </Border>
        </Grid>
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

            // Find elements
            _page1Welcome = (Grid)_window.FindName("Page1Welcome");
            _page2Destination = (Grid)_window.FindName("Page2Destination");
            _page3Options = (Grid)_window.FindName("Page3Options");
            _page4Progress = (Grid)_window.FindName("Page4Progress");
            _page5Finish = (Grid)_window.FindName("Page5Finish");

            _btnBack = (Button)_window.FindName("BtnBack");
            _btnNext = (Button)_window.FindName("BtnNext");
            _btnCancel = (Button)_window.FindName("BtnCancel");

            _lblStep1 = (TextBlock)_window.FindName("LblStep1");
            _lblStep2 = (TextBlock)_window.FindName("LblStep2");
            _lblStep3 = (TextBlock)_window.FindName("LblStep3");
            _lblStep4 = (TextBlock)_window.FindName("LblStep4");
            _lblStep5 = (TextBlock)_window.FindName("LblStep5");

            _txtInstallPath = (TextBox)_window.FindName("TxtInstallPath");
            _txtInstallPath.Text = _selectedPath;

            Button btnBrowse = (Button)_window.FindName("BtnBrowse");
            btnBrowse.Click += (s, e) => {
                System.Windows.Forms.FolderBrowserDialog fbd = new System.Windows.Forms.FolderBrowserDialog();
                fbd.Description = "Selecione a pasta onde deseja instalar o VPNDS:";
                fbd.SelectedPath = _txtInstallPath.Text;
                if (fbd.ShowDialog() == System.Windows.Forms.DialogResult.OK) {
                    _selectedPath = fbd.SelectedPath;
                    _txtInstallPath.Text = _selectedPath;
                }
            };

            _chkAutostart = (CheckBox)_window.FindName("ChkAutostart");
            _chkDesktopShortcut = (CheckBox)_window.FindName("ChkDesktopShortcut");
            _chkStartMenu = (CheckBox)_window.FindName("ChkStartMenu");
            _chkDiscordBypass = (CheckBox)_window.FindName("ChkDiscordBypass");
            _chkLaunchNow = (CheckBox)_window.FindName("ChkLaunchNow");

            _progressBar = (ProgressBar)_window.FindName("ProgressBar");
            _lblProgressStatus = (TextBlock)_window.FindName("LblProgressStatus");
            _lblProgressDetails = (TextBlock)_window.FindName("LblProgressDetails");

            _btnCancel.Click += (s, e) => {
                if (_currentStep == 4) {
                    MessageBox.Show("A instalacao esta em andamento. Aguarde.", "Aviso", MessageBoxButton.OK, MessageBoxImage.Information);
                    return;
                }
                _window.Close();
            };

            _btnBack.Click += (s, e) => {
                if (_currentStep > 1 && _currentStep < 4) {
                    SetStep(_currentStep - 1);
                }
            };

            _btnNext.Click += (s, e) => {
                if (_currentStep == 1) {
                    SetStep(2);
                } else if (_currentStep == 2) {
                    string p = _txtInstallPath.Text.Trim();
                    if (string.IsNullOrEmpty(p)) {
                        MessageBox.Show("Por favor informe um caminho de instalacao valido.", "Aviso", MessageBoxButton.OK, MessageBoxImage.Warning);
                        return;
                    }
                    _selectedPath = p;
                    SetStep(3);
                } else if (_currentStep == 3) {
                    SetStep(4);
                    StartInstallation();
                } else if (_currentStep == 5) {
                    if (_chkLaunchNow.IsChecked == true) {
                        string targetExe = Path.Combine(_selectedPath, "VPNDS.exe");
                        if (File.Exists(targetExe)) {
                            Process.Start(new ProcessStartInfo {
                                FileName = targetExe,
                                WorkingDirectory = _selectedPath
                            });
                        }
                    }
                    _window.Close();
                }
            };

            _window.ShowDialog();
        }

        private static void SetStep(int step) {
            _currentStep = step;

            _page1Welcome.Visibility = (step == 1) ? Visibility.Visible : Visibility.Collapsed;
            _page2Destination.Visibility = (step == 2) ? Visibility.Visible : Visibility.Collapsed;
            _page3Options.Visibility = (step == 3) ? Visibility.Visible : Visibility.Collapsed;
            _page4Progress.Visibility = (step == 4) ? Visibility.Visible : Visibility.Collapsed;
            _page5Finish.Visibility = (step == 5) ? Visibility.Visible : Visibility.Collapsed;

            // Highlight active step on sidebar
            UpdateStepLabel(_lblStep1, step == 1);
            UpdateStepLabel(_lblStep2, step == 2);
            UpdateStepLabel(_lblStep3, step == 3);
            UpdateStepLabel(_lblStep4, step == 4);
            UpdateStepLabel(_lblStep5, step == 5);

            // Button configurations
            _btnBack.Visibility = (step > 1 && step < 4) ? Visibility.Visible : Visibility.Collapsed;

            var borderNext = (Border)_btnNext.Template.FindName("b", _btnNext);
            var txtNext = (TextBlock)_btnNext.Template.FindName("txt", _btnNext);

            if (step == 3) {
                if (txtNext != null) txtNext.Text = "Instalar";
            } else if (step == 4) {
                _btnBack.Visibility = Visibility.Collapsed;
                _btnNext.IsEnabled = false;
                _btnCancel.IsEnabled = false;
                if (txtNext != null) txtNext.Text = "Instalando...";
            } else if (step == 5) {
                _btnBack.Visibility = Visibility.Collapsed;
                _btnCancel.Visibility = Visibility.Collapsed;
                _btnNext.IsEnabled = true;
                if (txtNext != null) txtNext.Text = "Concluir";
            } else {
                _btnNext.IsEnabled = true;
                _btnCancel.IsEnabled = true;
                if (txtNext != null) txtNext.Text = "Avancar >";
            }
        }

        private static void UpdateStepLabel(TextBlock tb, bool active) {
            if (active) {
                tb.Foreground = (Brush)_bc.ConvertFromString("#FFFFFF");
                tb.FontWeight = FontWeights.Bold;
            } else {
                tb.Foreground = (Brush)_bc.ConvertFromString("#52525B");
                tb.FontWeight = FontWeights.SemiBold;
            }
        }

        private static async void StartInstallation() {
            string sourceDir = AppDomain.CurrentDomain.BaseDirectory;
            string targetDir = _selectedPath;

            bool autostart = _chkAutostart.IsChecked == true;
            bool desktopShortcut = _chkDesktopShortcut.IsChecked == true;
            bool startMenuShortcut = _chkStartMenu.IsChecked == true;
            bool discordBypass = _chkDiscordBypass.IsChecked == true;

            await Task.Run(() => {
                try {
                    // Step A: Target directory
                    UpdateProgress(15, "Criando diretorio de destino...", targetDir);
                    if (!Directory.Exists(targetDir)) {
                        Directory.CreateDirectory(targetDir);
                    }
                    System.Threading.Thread.Sleep(300);

                    // Step B: Copy files
                    UpdateProgress(30, "Copiando binarios e dependencias...", "VPNDS.exe");
                    CopyAll(new DirectoryInfo(sourceDir), new DirectoryInfo(targetDir));
                    System.Threading.Thread.Sleep(400);

                    string targetExe = Path.Combine(targetDir, "VPNDS.exe");
                    string targetIcon = Path.Combine(targetDir, "app_vpnds.ico");
                    if (!File.Exists(targetIcon)) targetIcon = Path.Combine(targetDir, "app.ico");

                    // Step C: Shortcuts
                    if (desktopShortcut) {
                        UpdateProgress(55, "Criando atalho na Area de Trabalho...", "VPNDS.lnk");
                        string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                        string lnk = Path.Combine(desktopPath, "VPNDS.lnk");
                        CreateShortcut(lnk, targetExe, targetDir, targetIcon);
                    }

                    if (startMenuShortcut) {
                        UpdateProgress(70, "Criando atalho no Menu Iniciar...", "VPNDS.lnk");
                        string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "VPNDS");
                        if (!Directory.Exists(startMenu)) Directory.CreateDirectory(startMenu);
                        string lnk = Path.Combine(startMenu, "VPNDS.lnk");
                        CreateShortcut(lnk, targetExe, targetDir, targetIcon);
                    }

                    // Step D: Registry Autostart
                    if (autostart) {
                        UpdateProgress(85, "Configurando inicializacao automatica com Windows...", "HKCU\\Run");
                        try {
                            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) {
                                if (key != null) {
                                    key.SetValue("VPNDS", "\"" + targetExe + "\"");
                                }
                            }
                        } catch { }
                    }

                    // Step E: Discord Bypass
                    if (discordBypass) {
                        UpdateProgress(95, "Aplicando desbloqueio de 1ms no Discord...", "discord_vpn_manager.ps1");
                        try {
                            string mgr = Path.Combine(targetDir, "core", "discord_vpn_manager.ps1");
                            if (File.Exists(mgr)) {
                                ProcessStartInfo psi = new ProcessStartInfo {
                                    FileName = "powershell.exe",
                                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + mgr + "\" -Action Install",
                                    CreateNoWindow = true,
                                    UseShellExecute = false
                                };
                                using (Process p = Process.Start(psi)) {
                                    if (p != null) p.WaitForExit(15000);
                                }
                            }
                        } catch { }
                    }

                    UpdateProgress(100, "Instalacao concluida!", "Tudo pronto.");
                    System.Threading.Thread.Sleep(400);
                } catch (Exception ex) {
                    _window.Dispatcher.Invoke(() => {
                        MessageBox.Show("Aviso durante a instalacao: " + ex.Message, "Aviso", MessageBoxButton.OK, MessageBoxImage.Warning);
                    });
                }
            });

            SetStep(5);
        }

        private static void UpdateProgress(int pct, string status, string details) {
            _window.Dispatcher.Invoke(() => {
                _progressBar.Value = pct;
                _lblProgressStatus.Text = status;
                _lblProgressDetails.Text = details;
            });
        }

        private static void CopyAll(DirectoryInfo source, DirectoryInfo target) {
            Directory.CreateDirectory(target.FullName);

            foreach (FileInfo fi in source.GetFiles()) {
                // Ignore installer and source files
                string name = fi.Name.ToLower();
                if (name.StartsWith("instalador") || name.StartsWith("setup") || name.EndsWith(".cs") || name.EndsWith(".old") || name.EndsWith(".tmp")) {
                    continue;
                }
                string destFile = Path.Combine(target.FullName, fi.Name);
                fi.CopyTo(destFile, true);
            }

            foreach (DirectoryInfo diSourceSubDir in source.GetDirectories()) {
                string subName = diSourceSubDir.Name.ToLower();
                if (subName.StartsWith(".") || subName == "bin" || subName == "obj") continue;

                DirectoryInfo nextTargetSubDir = target.CreateSubdirectory(diSourceSubDir.Name);
                CopyAll(diSourceSubDir, nextTargetSubDir);
            }
        }

        private static void CreateShortcut(string shortcutPath, string targetPath, string workDir, string iconPath) {
            try {
                string script = 
                    "$w = New-Object -ComObject WScript.Shell; " +
                    "$s = $w.CreateShortcut('" + shortcutPath.Replace("'", "''") + "'); " +
                    "$s.TargetPath = '" + targetPath.Replace("'", "''") + "'; " +
                    "$s.WorkingDirectory = '" + workDir.Replace("'", "''") + "'; " +
                    (File.Exists(iconPath) ? "$s.IconLocation = '" + iconPath.Replace("'", "''") + "'; " : "") +
                    "$s.Description = 'VPNDS - Painel de Controle, DNS e Bypass Discord'; " +
                    "$s.Save()";

                ProcessStartInfo psi = new ProcessStartInfo {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + script + "\"",
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                using (Process p = Process.Start(psi)) {
                    if (p != null) p.WaitForExit(4000);
                }
            } catch { }
        }
    }
}
