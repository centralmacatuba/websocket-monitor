# Central Macatuba — WebSocket Monitor

Monitor externo de disponibilidade e integridade funcional dos relays da Central Macatuba, executado pelo GitHub Actions.

## Serviços monitorados

| Serviço | Cliente/protocolo | Verificação funcional |
|---|---|---|
| Mcraft P2P (Trystero) | `@trystero-p2p/ws-relay` + `werift` | Dois processos Trystero entram em uma sala efêmera e trocam uma ação com nonce e ACK por WebRTC. |
| EaglerCraft Relay | EaglerSPRelay v1 | Envia o handshake de ping do protocolo (tipo de conexão 0x03) e valida a resposta PKT 0x69. |
| Mcraft P2P (PeerJS legado) | `peerjs` + `werift` | Dois peers efêmeros registram-se, abrem DataChannel raw e trocam payload binário/ACK. |
| EaglerCraft Wisp | `@mercuryworkshop/wisp-js` 0.5.3 | Negocia Wisp v2 pelo cliente oficial e valida a versão negociada. |

Cada serviço é independente. Uma falha, desativação ou ausência de configuração de um serviço não interrompe os demais. Os resultados distinguem serviços desativados, fora do horário de verificação, mal configurados e com falha.

Trystero e PeerJS usam dois participantes de teste efêmeros. A comunicação WebRTC é feita diretamente entre os processos do runner; não é usado TURN nem tráfego de jogo. A verificação Wisp confirma a negociação v2; um teste de stream TCP não é executado porque não há destino de echo de teste configurado. O EaglerSPRelay recebe somente um ping de protocolo, sem criar Shared World ou código de sessão.

## Configuração do GitHub

Configure os toggles e intervalos em **Settings → Secrets and variables → Actions → Variables**. Configure os endpoints em **Secrets**.

### Variáveis globais

| Variable | Padrão | Descrição |
|---|---:|---|
| `WS_MONITOR_ENABLED` | `true` | Liga/desliga todo o monitor. |
| `WS_MONITOR_INTERVAL_MINUTES` | `5` | Intervalo global, em minutos. Mantém o intervalo original de cinco minutos. |

### Variáveis por serviço

| Serviço | Ativar/desativar | Intervalo individual | Secret da URL |
|---|---|---|---|
| Trystero | `TRYSTERO_MONITOR_ENABLED` | `TRYSTERO_MONITOR_INTERVAL_MINUTES` | `MCRAFT_TRYSTERO_WS_URL` |
| EaglerCraft Relay | `EAGLERCRAFT_RELAY_MONITOR_ENABLED` | `EAGLERCRAFT_RELAY_MONITOR_INTERVAL_MINUTES` | `EAGLERCRAFT_RELAY_WS_URL` |
| PeerJS | `PEERJS_MONITOR_ENABLED` | `PEERJS_MONITOR_INTERVAL_MINUTES` | `PEERJS_WS_URL` |
| Wisp | `WISP_MONITOR_ENABLED` | `WISP_MONITOR_INTERVAL_MINUTES` | `WISP_WS_URL` |

São 14 configurações: 2 globais e 3 para cada um dos 4 serviços. Se um toggle individual não for definido, o serviço é habilitado automaticamente quando seu secret de URL existe; sem URL, ele fica desabilitado por padrão. Se o toggle for explicitamente `true` sem URL, a execução reporta erro de configuração. Se o intervalo individual estiver vazio ou inválido, será herdado o intervalo global.

Os intervalos são em minutos inteiros positivos. O workflow agenda um tick a cada cinco minutos (menor intervalo suportado pelo agendador do GitHub) e o monitor decide individualmente se cada serviço está no seu minuto de execução. Intervalos menores que cinco minutos são arredondados para cinco; os demais são arredondados para o próximo múltiplo de cinco. A agenda do GitHub Actions é best-effort e não garante precisão temporal. A execução manual força todos os serviços habilitados, ignorando os intervalos.

Exemplos:
- Definir `WS_MONITOR_ENABLED=false` pausa tudo.
- Definir `WS_MONITOR_INTERVAL_MINUTES=10` verifica todos os serviços habilitados a cada dez minutos, salvo sobrescrita individual.
- Definir `PEERJS_MONITOR_ENABLED=true` e cadastrar `PEERJS_WS_URL` ativa PeerJS.
- Definir `WISP_MONITOR_INTERVAL_MINUTES=15` faz Wisp executar a cada quinze minutos.

### URLs

- Trystero e EaglerCraft Relay: URL WebSocket completa (`wss://...`).
- PeerJS: URL base HTTP(S) ou WS(S) do servidor PeerJS, incluindo o caminho configurado (normalmente `/peerjs`). O parâmetro `key` pode ser incluído na URL se o servidor usar uma chave diferente da padrão.
- Wisp: URL WebSocket completa incluindo o caminho Wisp configurado (por exemplo, `wss://host/caminho/`).

Não inclua credenciais ou tokens nas URLs. Os logs não imprimem endpoints, payloads, IDs temporários ou mensagens recebidas.

## Execução automática e Render Free

O workflow roda a cada minuto para permitir intervalos independentes; o processo só abre conexões quando o intervalo de cada serviço vence. O padrão permanece cinco minutos. Cada ciclo usa até oito tentativas, com dez segundos entre tentativas, para tolerar cold starts. Isso pode acordar serviços no Render Free e manter atividade, consumindo horas de instância; não remove limites do plano gratuito. O agendamento do GitHub é best-effort.

## Execução local

Requisitos: Node.js 22+ e pnpm 12.12.1.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm monitor
```

Defina os secrets/variáveis correspondentes no ambiente antes de executar. Em uma execução local, todos os serviços habilitados são executados imediatamente.

## Segurança

- Nenhuma URL ou credencial é escrita nos logs.
- Os payloads de teste são pequenos, aleatórios e efêmeros.
- As salas e peers Trystero/PeerJS são encerrados após o teste. O appId do Trystero é exclusivo do monitor para impedir que o teste encontre salas reais.
- EaglerSPRelay recebe somente um pacote ping oficial e não cria mundos.
- Wisp negocia versão sem abrir streams para destinos externos.
- O workflow mantém permissão `contents: read` e checkout com `persist-credentials: false`.
- O teste de transporte WebSocket genérico continua disponível em `src/check-websocket.js`, mas os quatro probes usam clientes ou mensagens de protocolo próprios.

## Licença

Nenhuma licença de redistribuição foi declarada neste repositório.
