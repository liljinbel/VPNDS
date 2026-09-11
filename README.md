# 🛡️ VPNDS • Painel de Controle & Instalador Profissional

O **VPNDS** é um software nativo para Windows com interface moderna em **Preto e Branco com detalhes em Vidro Fosco (Frosted Glass / Glassmorphism)**, combinando alteração de DNS com ultra-baixa latência (IPv4 + IPv6), bypass de inspeção de pacotes com **GoodbyeDPI** e **VPN de 1ms dedicada para Discord** com desbloqueio automático de tela e câmera.

---

## 🎨 Novo Visual: Frosted Glass Black & White (Vidro Fosco)
- **Tema Obsidian & Platinum**: Fundo escuro profundo (`#09090B`), cartões em acrílico translúcido (`#121216`), bordas de titânio acetinado e botões em branco puro de alto contraste.
- **Novo Ícone `.ico`**: Escudo geométrico fosco em alta resolução com monograma "V" iluminado e bevel prateado (`app_vpnds.ico`), embutido diretamente nos executáveis.

---

## 📦 Como Mandar para os Seus Amigos (Instalador Profissional)

Para enviar aos seus amigos como um programa comercial completo:

1. Envie a pasta **`VPNDS_Instalador`** (ou o arquivo **`VPNDS_Instalador.zip`**).
2. O seu amigo só precisa dar **2 cliques em `Instalador_VPNDS.exe`**.
3. O assistente de instalação abrirá com o passo a passo profissional:
   - **Passo 1 • Boas-vindas**: Apresentação dos recursos.
   - **Passo 2 • Destino**: Escolha da pasta onde instalar (padrão em `AppData\Local\Programs\VPNDS` com botão Procurar).
   - **Passo 3 • Opções & Inicialização**: Opção para **Iniciar com o Windows**, criar atalhos na **Área de Trabalho** e **Menu Iniciar**, e aplicar o desbloqueio do Discord.
   - **Passo 4 • Instalação**: Barra de progresso ao vivo copiando arquivos e registrando o sistema.
   - **Passo 5 • Conclusão**: Opção de abrir o VPNDS imediatamente.

Para gerar um novo pacote zip a qualquer momento, basta executar:
```cmd
Criar_Pacote_Amigos.bat
```

---

## 🎛️ Recursos do Painel VPNDS

- **👾 VPN no Discord (Desbloqueio de Tela/Câmera • 1ms Nativo • Auto 2 min)**:
  - **Exclusivo para o Discord**: Não afeta navegadores, jogos ou o resto do computador. Seu PC continua na internet normal.
  - **Desbloqueia Go Live**: Contorna a restrição brasileira autenticando a conexão inicial fora do Brasil.
  - **Desativação Automática em 2 Minutos**: Após autenticar, a rota é desligada automaticamente e o Discord passa a usar sua internet 100% direta nativa com **1ms de ping** para o resto da sessão!
  - **1 Clique para Implementar ou Remover**: Botão de implementação direta no painel.

- **⚡ VPN Leve Geral (Bypass DPI - GoodbyeDPI Embutido)**:
  - **Zero lentidão (+1ms)**: Mantém a velocidade total da sua conexão sem redirecionar pacotes para servidores lentos.
  - **Sem contas ou mensalidades**: Pronto para uso em 1 clique.
  - **Libera YouTube e sites bloqueados**: Ignora filtros de operadoras e inspeções de pacotes.

- **Cartões Interativos de DNS**:
  - ⚡ **Cloudflare DNS** (`1.1.1.1` e `1.0.0.1` + IPv6) — Ultra Rápido.
  - 🌐 **Google Public DNS** (`8.8.8.8` e `8.8.4.4` + IPv6) — Mais Estável.
  - 🛡️ **Quad9 Security** (`9.9.9.9` e `149.112.112.112` + IPv6) — Segurança Anti-Malware.
  - 🔒 **OpenDNS** (`208.67.222.222` e `208.67.220.220` + IPv6) — Familiar.
  - 🚫 **AdGuard DNS** (`94.140.14.14` e `94.140.15.15` + IPv6) — Sem Anúncios.

- **Botão Mestre de Retorno**:
  - Restaura instantaneamente seu DNS original com 1 clique e desliga a VPN.

- **Botão "Testar Pings"**:
  - Mede a latência em tempo real de cada servidor DNS exibindo o valor em milissegundos.

---

## 📁 Estrutura de Arquivos

- **`Instalador_VPNDS.exe`** → Assistente de instalação no estilo Wizard (Avançar, Escolher Pasta, Iniciar com Windows).
- **`VPNDS.exe`** → O aplicativo principal portátil.
- **`VPNDS_Instalador.zip`** → Arquivo zip pronto para enviar aos seus amigos.
- **`Criar_Pacote_Amigos.bat`** → Script para compilar e gerar o pacote zip para amigos.
- **`Compilar.bat`** → Compila o `VPNDS.exe` atualizado.
- **`core/`** → Motores locais (Tor, GoodbyeDPI, WinDivert, scripts de automação).
- **`app_vpnds.ico`** → Novo ícone em alta resolução Preto & Branco / Vidro Fosco.

