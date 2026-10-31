# Central Macatuba — WebSocket Monitor

Monitor externo dos relays WebSocket da Central Macatuba, executado pelo GitHub Actions.

O monitor verifica dois serviços:

| Serviço | Endpoint | Verificação |
|---|---|---|
| Mcraft P2P (Trystero) | `wss://<host>/` | Handshake WebSocket + Ping/Pong |
| EaglerCraft Relay | `wss://<host>/` | Handshake WebSocket + Ping/Pong |

O PeerJS legado não faz parte deste monitor.

## Por que a verificação é WebSocket?

Os dois relays recebem conexões WebSocket na raiz:

- **Trystero:** o servidor usa `@trystero-p2p/ws-relay` e aceita WebSocket em `/`. O endpoint HTTP `/health` existe, mas não substitui o teste do transporte WebSocket.
- **EaglerCraft Relay:** o relay Java usa a raiz `/` para WebSocket. A resposta HTTP informativa da raiz não é um endpoint de saúde; por isso, o monitor não faz uma requisição HTTP convencional.

Cada verificação abre uma conexão real, confirma o handshake HTTP 101, envia um frame WebSocket Ping, aguarda o Pong automático do servidor e fecha a conexão com o código 1000. Não envia mensagens de jogo, códigos de sala ou dados de sinalização.

> O teste confirma que o endpoint aceita WebSocket e responde aos frames de controle. Ele não substitui um teste funcional completo com clientes MWC/EaglerCraft nem confirma que a troca de mensagens específica da aplicação está funcionando.

## Configuração no GitHub

Depois de integrar esta branch à branch padrão do repositório, configure os seguintes **Repository secrets** em **Settings → Secrets and variables → Actions**:

| Secret | Conteúdo |
|---|---|
| `MCRAFT_TRYSTERO_WS_URL` | URL WebSocket completa do relay Trystero |
| `EAGLERCRAFT_RELAY_WS_URL` | URL WebSocket completa do EaglerCraft Relay |

Exemplos de formato (substitua pelos endereços efetivamente atribuídos pelo Render):

```text
MCRAFT_TRYSTERO_WS_URL=wss://<servico-trystero>.onrender.com/
EAGLERCRAFT_RELAY_WS_URL=wss://<servico-eaglercraft>.onrender.com/
```

Use preferencialmente o hostname `onrender.com` atribuído a cada Web Service. Também é possível usar o domínio personalizado depois de confirmar que o DNS e o TLS estão válidos. Não inclua credenciais, tokens ou parâmetros secretos nas URLs.

Os secrets não são necessários para executar a suíte de testes. A execução do monitor falha explicitamente se algum deles estiver ausente.

## Execução automática

A workflow `.github/workflows/websocket-monitor.yml` agenda uma verificação a cada cinco minutos e também permite execução manual em **Actions → WebSocket Relay Monitor → Run workflow**.

Quando um serviço não responde, o monitor tenta novamente até oito vezes, aguardando dez segundos entre tentativas. Isso dá tempo para o cold start do Render Free (que pode levar aproximadamente um minuto). Os dois relays são verificados em paralelo; a falha de um não impede que o outro seja testado.

O GitHub Actions usa agendamentos de melhor esforço: execuções podem atrasar, especialmente em períodos de alta demanda. Portanto, o intervalo de cinco minutos não é uma garantia rígida nem uma garantia de disponibilidade 24/7.

### Relação com o Render Free

O Render informa que um Web Service Free entra em repouso depois de 15 minutos sem tráfego de entrada e volta a iniciar quando recebe uma requisição HTTP ou uma nova conexão WebSocket. Esta workflow abre novas conexões WebSocket, portanto pode acordar os relays e, enquanto as verificações chegam regularmente, gerar tráfego de entrada.

Isso **não remove as limitações do Render Free**:

- O serviço pode ser reiniciado ou suspenso por outros motivos.
- O GitHub Actions pode atrasar uma execução agendada.
- As horas de instância continuam sendo contabilizadas enquanto o serviço está ativo.
- O workspace continua sujeito à franquia de 750 horas gratuitas por mês.
- A conexão de monitoramento não garante disponibilidade contínua nem substitui um plano de produção.

Com verificações regulares, cada serviço monitorado pode consumir praticamente as horas de um mês inteiro (aproximadamente 720 horas em um mês de 30 dias ou 744 em um mês de 31 dias). No workspace Mcraft P2P, somente o Trystero é monitorado; o PeerJS legado fica fora desta rotina.

Referência: [Render — Deploy for Free](https://render.com/docs/free).

## Execução local

Requisitos:

- Node.js 22 ou superior.
- pnpm 12.12.1.

Instale as dependências:

```bash
pnpm install --frozen-lockfile
```

Execute verificações de código e testes:

```bash
pnpm check
pnpm test
```

Execute o monitor (requer os dois endereços):

```bash
MCRAFT_TRYSTERO_WS_URL=wss://host-trystero/ \
EAGLERCRAFT_RELAY_WS_URL=wss://host-eaglercraft/ \
pnpm monitor
```

No PowerShell, defina as variáveis de ambiente com `$env:NOME="valor"` antes de executar `pnpm monitor`.

## Configurações opcionais

| Variável | Padrão | Descrição |
|---|---:|---|
| `WS_CONNECT_TIMEOUT_MS` | `15000` | Timeout do handshake de cada tentativa |
| `WS_PONG_TIMEOUT_MS` | `5000` | Tempo máximo para receber Pong após Ping |
| `WS_MAX_ATTEMPTS` | `8` | Número máximo de tentativas por serviço |
| `WS_RETRY_DELAY_MS` | `10000` | Intervalo entre tentativas |
| `WS_CLOSE_TIMEOUT_MS` | `1000` | Tempo antes de forçar o encerramento local |

Os valores padrão são usados no GitHub Actions. Ajuste-os somente se houver uma razão operacional.

## Estrutura

```text
.github/
├── dependabot.yml
└── workflows/
    ├── ci.yml
    └── websocket-monitor.yml
src/
├── check-websocket.js
└── monitor.js
tests/
└── check-websocket.test.js
package.json
pnpm-lock.yaml
```

## Segurança e privacidade

- Os endereços dos serviços são armazenados como GitHub Actions secrets.
- O monitor não imprime a URL completa, query strings ou credenciais nos logs.
- O workflow possui somente permissão `contents: read`.
- Não são enviados dados de jogo, mensagens Trystero, códigos de mundo ou credenciais de TURN.
- As conexões são encerradas após o Ping/Pong.

## Licença

Nenhuma licença de redistribuição foi declarada neste repositório.
