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

## Incidentes, histórico e notificações

O workflow usa o próprio GitHub como backend, sem servidor, banco de dados ou serviço pago adicional:

- Quando um probe falha após todas as tentativas, abre uma issue `[WebSocket Monitor][DOWN]` para aquele serviço. A issue funciona como alerta e registro do início do incidente.
- Enquanto o serviço continuar indisponível, a mesma issue permanece aberta; verificações subsequentes não criam alertas duplicados.
- Quando o probe volta a funcionar, o monitor comenta a recuperação e fecha a issue. O histórico de issues preserva início, recuperação e duração do incidente.
- Cada verificação de protocolo efetivamente executada é registrada como uma amostra compacta em um comentário diário por serviço na issue de métricas. Cada amostra contém timestamp, resultado, duração total do probe e número de tentativas.
- As amostras são atualizadas por comentário, sem criar um commit a cada cinco minutos. O monitor mantém uma série por serviço/dia, evita timestamps duplicados em reruns e limita o tamanho de cada comentário.
- Janelas de manutenção suprimem a abertura de novos incidentes para os serviços abrangidos. Incidentes já abertos continuam sendo atualizados e fechados normalmente quando houver recuperação.

O monitor precisa da permissão GitHub Actions **Issues: Read and write** para abrir/atualizar incidentes e registrar amostras. O workflow declara somente `contents: read` e `issues: write`; o token é fornecido automaticamente por `GITHUB_TOKEN` e não precisa ser cadastrado como secret. Nenhuma URL de relay ou credencial é incluída nas issues.

## Status Page pública

A página estática fica em `status-page/` e é publicada pelo workflow `.github/workflows/status-page.yml` no GitHub Pages. Não há branch `gh-pages`, framework pesado, servidor Render ou banco de dados externo.

**Endereço esperado:** https://centralmacatuba.github.io/websocket-monitor/

A publicação é acionada quando o workflow de monitoramento termina (inclusive quando o resultado de um probe faz o workflow terminar com falha), quando os arquivos da página mudam na branch `principal`, ou manualmente. O builder lê as issues/comentários públicos do próprio repositório, gera JSON estático e badges SVG e publica tudo pelo fluxo oficial de artefatos do GitHub Pages.

### Métricas de uptime e latência

- **24 horas, 7 dias e 30 dias:** percentual calculado como verificações bem-sucedidas ÷ verificações executadas × 100.
- **Sem dados:** se não houver amostras no período, o valor é exibido como “Coletando dados”, nunca como 100%.
- **Amostras reais:** somente probes executados entram no cálculo. Serviços em intervalos diferentes não recebem verificações artificiais nos minutos em que não estavam programados.
- **Manutenções:** por padrão, verificações dentro de uma janela de manutenção são excluídas do cálculo de uptime. Use `"excludeFromUptime": false` para manter essas verificações no denominador.
- **Latência:** mede a duração do probe de protocolo bem-sucedido, sem somar o tempo de retries; a página mostra histórico das últimas 24 horas, média e P95. Verificações que falham contam no uptime, mas não são tratadas como medições de latência.
- **Dados antigos:** se a última amostra ultrapassar três intervalos esperados (com mínimo de 15 minutos), o serviço aparece como “Sem dados recentes”, em vez de continuar sendo exibido como operacional.
- **Retenção visual:** os gráficos e agregações da página usam as amostras dos últimos 30 dias. Os comentários históricos permanecem na issue de métricas.

A disponibilidade apresentada é uma **taxa observada por verificações**, não uma medição contínua de cada segundo. Um intervalo entre checks sem amostra não é automaticamente classificado como uptime ou downtime.

### Status e desempenho degradado

Cada serviço pode estar em um destes estados:

- **Operacional:** último probe recente concluído com sucesso e latência dentro do limite.
- **Desempenho degradado:** probe de protocolo concluiu com sucesso, mas a latência ultrapassou o limite configurado.
- **Indisponível:** último probe executado falhou.
- **Em manutenção:** existe uma janela de manutenção ativa para o serviço ou para todos.
- **Sem dados recentes:** não há amostra ou a última amostra está obsoleta.

Os limites iniciais ficam em `status-page/config.json`, na propriedade `degradedLatencyMs` de cada serviço. Ajuste os limites conforme o comportamento real dos relays; eles são critérios de apresentação, não falhas de protocolo.

### Manutenções programadas

Edite `status-page/maintenance.json` na branch `principal`:

```json
{
  "maintenances": [
    {
      "id": "maintenance-2026-01",
      "service": "all",
      "title": "Manutenção de infraestrutura",
      "description": "Atualização planejada dos serviços.",
      "startsAt": "2026-12-01T02:00:00.000Z",
      "endsAt": "2026-12-01T03:00:00.000Z",
      "status": "scheduled",
      "excludeFromUptime": true
    }
  ]
}
```

Use `service: "all"` para todos os relays ou um ID específico: `trystero`, `eaglercraft`, `peerjs` ou `wisp`. Os horários são ISO 8601 em UTC. A manutenção é exibida enquanto não tiver terminado; durante a janela, falhas previstas não abrem novos incidentes. Os probes continuam executando e registrando amostras para diagnóstico.

### Badges

O workflow gera SVGs atualizados para o status geral e para cada serviço:

- `/badges/overall.svg`
- `/badges/trystero.svg`
- `/badges/eaglercraft.svg`
- `/badges/peerjs.svg`
- `/badges/wisp.svg`

A página mostra os badges e o snippet Markdown correspondente para inclusão em READMEs e documentações.

### Ativação do GitHub Pages

Depois que as alterações forem integradas à branch `principal`:

1. Abra **Settings → Pages** no repositório.
2. Em **Build and deployment → Source**, selecione **GitHub Actions**.
3. Execute manualmente o workflow **Publish Status Page** ou aguarde a próxima verificação do monitor.
4. O endereço publicado aparecerá no ambiente `github-pages` e no resultado do workflow.

O deploy exige as permissões `pages: write` e `id-token: write`, concedidas somente ao job de publicação. O job que consulta os incidentes usa apenas `issues: read`.

## Execução automática e Render Free

O workflow roda a cada cinco minutos (menor cadência suportada pelo agendador do GitHub Actions); o processo só abre conexões quando o intervalo de cada serviço vence. O padrão permanece cinco minutos. Cada ciclo usa até oito tentativas, com dez segundos entre tentativas, para tolerar cold starts. Isso pode acordar serviços no Render Free e manter atividade, consumindo horas de instância; não remove limites do plano gratuito. O agendamento do GitHub é best-effort.

## Execução local

Requisitos: Node.js 22+ e pnpm 12.12.1.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm monitor
```

Defina os secrets/variáveis correspondentes no ambiente antes de executar. Em uma execução local, todos os serviços habilitados são executados imediatamente. O histórico no GitHub só é sincronizado quando `GITHUB_TOKEN` e `GITHUB_REPOSITORY` estão definidos.

## Segurança

- Nenhuma URL ou credencial é escrita nos logs.
- Os payloads de teste são pequenos, aleatórios e efêmeros.
- As salas e peers Trystero/PeerJS são encerrados após o teste. O appId do Trystero é exclusivo do monitor para impedir que o teste encontre salas reais.
- EaglerSPRelay recebe somente um pacote ping oficial e não cria mundos.
- Wisp negocia versão sem abrir streams para destinos externos.
- O workflow mantém permissões mínimas: `contents: read` e `issues: write`; checkout usa `persist-credentials: false`.
- O teste de transporte WebSocket genérico continua disponível em `src/check-websocket.js`, mas os quatro probes usam clientes ou mensagens de protocolo próprios.

## Licença

Este projeto é distribuído sob a licença [MIT](LICENSE). A licença do projeto não substitui nem altera as licenças das dependências de terceiros; consulte os metadados de cada pacote e seus avisos aplicáveis.

## Política de segurança

Consulte [SECURITY.md](SECURITY.md) para saber como reportar vulnerabilidades de forma privada.
