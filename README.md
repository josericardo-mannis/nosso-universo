# Nosso Universo na Cloudflare

O app dos Gatitos com a Neide, no endereço de vocês, com login só para o Zé e a Raquel.

## Como funciona

| Peça | Serviço | Custo |
|---|---|---|
| Site e API | Cloudflare Workers (`src/worker.js` + `public/`) | grátis (até 100 mil acessos por dia) |
| Banco de dados | Cloudflare D1 (`db/schema.sql`, `db/seed.sql`) | grátis (até 5 GB) |
| Login só para vocês dois | Cloudflare Access (Zero Trust), código por e-mail | grátis (até 50 pessoas) |
| Neide | API da Anthropic, chamada pelo Worker | pago por uso (veja o fim) |
| Domínio próprio (opcional) | registro.br ou Cloudflare Registrar | ~R$ 40/ano (.com.br) |

A chave da Anthropic fica guardada como segredo no Worker e nunca chega ao celular. A API também confere o login do Access em cada pedido. Mesmo que alguém descubra o endereço, não vê nem altera os dados.

---

## Passo a passo (uma vez, ~40 minutos)

### 1. Conta na Cloudflare
1. Crie a conta em https://dash.cloudflare.com/sign-up e confirme o e-mail.
2. Em **My Profile → Authentication**, ligue a verificação em duas etapas.

### 2. Banco de dados (D1)
1. No painel: **Storage & Databases → D1 SQL Database → Create**.
2. Nome: `nosso-universo`. Crie.
3. Copie o **Database ID** que aparece e cole em `wrangler.jsonc`, no lugar de `COLE-AQUI-O-ID-DO-D1` (ou mande para o Claude fazer isso).
4. Não precisa rodar SQL nenhum: no primeiro acesso de vocês, o site cria a tabela e carrega sozinho os 142 registros que já estavam no app (`src/seed.json`).

### 3. Código no GitHub
1. Crie um repositório **privado** chamado `nosso-universo` em https://github.com/new. Deixe vazio, sem README.
2. Envie esta pasta para o repositório. O Claude faz isso se vocês derem acesso ao repositório na sessão; ou use **Add file → Upload files** e arraste o conteúdo da pasta, sem `node_modules`.

### 4. Publicar o Worker
1. No painel: **Workers & Pages → Create → Import a repository**.
2. Conecte o GitHub, escolha `nosso-universo` e clique em **Deploy**. Os comandos padrão servem: a Cloudflare instala as dependências e roda `npx wrangler deploy`.
3. O site fica em `https://nosso-universo.<seu-subdominio>.workers.dev`.
4. A partir daí, cada mudança enviada ao GitHub publica sozinha.

### 5. Login só para vocês (Cloudflare Access)
1. No Worker: **Settings → Domains & Routes**. Na linha `workers.dev`, ative **Cloudflare Access**.
   - Na primeira vez, a Cloudflare pede para criar a organização Zero Trust: escolha um nome de equipe (ex.: `gatitos`) e o plano **Free**. Pode pedir um cartão, mas o plano Free é US$ 0.
2. Em **Zero Trust → Access → Applications**, abra o app criado e edite a política:
   - **Action:** Allow
   - **Include → Emails:** o e-mail do Zé e o da Raquel
   - **Session duration:** 1 month, para não pedir login todo dia.
3. Anote dois valores:
   - o **Application Audience (AUD) Tag**, na página do app;
   - o **Team domain**, em **Zero Trust → Settings**. É algo como `gatitos.cloudflareaccess.com`.
4. Na mesma tela **Domains & Routes**, desative **Preview URLs**.

### 6. Variáveis e segredos do Worker
No Worker: **Settings → Variables and secrets → Add**.

| Nome | Tipo | Valor |
|---|---|---|
| `EMAIL_ZE` | Text | e-mail do Zé (o mesmo do Access) |
| `EMAIL_RAQUEL` | Text | e-mail da Raquel (o mesmo do Access) |
| `ACCESS_TEAM_DOMAIN` | Text | `gatitos.cloudflareaccess.com` (o seu) |
| `ACCESS_AUD` | Text | o AUD Tag copiado no passo 5 |
| `ANTHROPIC_API_KEY` | **Secret** | a chave do passo 7 |

Opcionais:

| Nome | Padrão | Para que serve |
|---|---|---|
| `NEIDE_MODEL` | `claude-opus-5-5` | troca o modelo da Neide |
| `NEIDE_EFFORT` | `low` | profundidade de raciocínio da Neide |

### 7. Chave da Neide (Anthropic)
1. Crie a conta em https://console.anthropic.com.
2. Em **Billing**, adicione créditos (ex.: US$ 10) e defina um limite mensal de gasto.
3. Em **API Keys → Create Key**, use o nome `nosso-universo`. Copie a chave e cole como segredo `ANTHROPIC_API_KEY` no passo 6.

### 8. No celular
1. Abra o endereço. A Cloudflare pede o e-mail e manda um código.
2. Entre e use **Adicionar à tela de início**. O app vira um ícone com a cara da Neide.
3. O app já sabe quem é quem pelo e-mail do login.
4. Na Neide, o botão de microfone grava de verdade. O navegador pede permissão na primeira vez.

### 9. Domínio próprio (opcional)
1. Registre o domínio. Para `.com.br`, use https://registro.br.
2. Na Cloudflare: **Add a domain**, plano Free. Troque os servidores DNS no registro.br pelos dois que a Cloudflare mostrar.
3. No Worker: **Settings → Domains & Routes → Add → Custom domain**, por exemplo `gatitos.com.br`.
4. No Zero Trust, adicione esse domínio ao mesmo app do Access.

---

## Google Agenda (convites para a Raquel e agendas dentro do app)

Como funciona:
- Ao conectar, o app cria a agenda **Gatitos** no Google do Zé. Tudo que for criado nela, pelo Google ou pelo app (eventos "dos dois"), convida a Raquel automaticamente em até 5 minutos.
- Eventos só do Zé vão para a agenda principal dele. Eventos só da Raquel ficam no app, sem ir para o Google.
- A cada 5 minutos o app puxa a agenda do Zé e a da Raquel. A da Raquel precisa estar compartilhada com o Zé.
- Os recados automáticos da Neide também saem por e-mail, pelo Gmail do Zé.

Configuração (uma vez, ~15 min, feita pelo Zé como admin do Workspace mannis.com.br):
1. https://console.cloud.google.com → seletor de projeto → **New project**: `nosso-universo` (organização mannis.com.br).
2. **APIs & Services → Library**: ative **Google Calendar API** e **Gmail API**.
3. **Google Auth Platform** (ou "OAuth consent screen") → Get started:
   - App name: `Nosso Universo`; support e-mail: o seu.
   - Audience: **Internal**. Assim não precisa de verificação do Google e a conexão não expira.
4. **Clients → Create client** → tipo **Web application** → nome `nosso-universo`.
   - Authorized redirect URI: `https://nosso-universo.jose-ricardo-857.workers.dev/api/google/callback`
5. Copie o **Client ID** e o **Client secret**. No Worker, em **Settings → Variables and Secrets**, cadastre:
   - `GOOGLE_CLIENT_ID` (Text)
   - `GOOGLE_CLIENT_SECRET` (**Secret**)
6. No app: **Ajustes → Google Agenda → Conectar Google Agenda**. Entre com a conta do Zé e aceite.
7. Raquel, no Google Agenda dela (computador): **Configurações** → a agenda dela → **Compartilhar com pessoas específicas** → adicione o e-mail do Zé com **Ver todos os detalhes dos eventos**.

## Rotinas automáticas

| Quando (São Paulo) | O que acontece |
|---|---|
| a cada 5 min | puxa as agendas do Google e convida a Raquel nos eventos da agenda Gatitos |
| todo dia 07:30 | recado do dia na tela inicial e por e-mail |
| domingo 19:00 | pauta do Conselho de Casa |
| dia 1º 08:00 | fechamento do mês |

O e-mail dos recados pode ser desligado em **Ajustes → Rotinas da Neide**.
Toda mudança fica registrada no "Movimento recente", e quem está com o app aberto recebe um aviso quando o outro mexe em algo.

## Quanto custa a Neide
A Neide roda no Claude Opus 5.5 com esforço baixo: US$ 4 por milhão de tokens de entrada e US$ 20 por milhão de saída. O cache de prompt reduz a parte repetida de cada conversa.

Cada pedido custa uns poucos centavos de dólar. Com uns 10 pedidos por dia, a estimativa é de algo entre US$ 10 e US$ 20 por mês. O limite mensal no console da Anthropic garante que não passa disso.

Se a Neide recusar um pedido por política de segurança, a API tenta de novo automaticamente com outro modelo. Isso é o `fallbacks: "default"` em `src/worker.js`.

## Para desenvolver no computador (opcional)
```bash
npm install
cp .dev.vars.example .dev.vars        # login simulado, só local
npx wrangler d1 execute nosso-universo --local --file db/schema.sql
npx wrangler d1 execute nosso-universo --local --file db/seed.sql
npx wrangler dev                      # http://localhost:8787
```

## Estrutura
```
public/index.html   o app (Neide, agenda, casa, grana, casório, telas, metas, datas)
public/mural.html   o mural de perguntas da Neide
public/cloud.js     ponte do app com a API (dados e Neide)
src/worker.js       API: /api/me, /api/data, /api/doc/:col/:id, /api/neide
db/schema.sql       tabela única de documentos
db/seed.sql         dados migrados do app no claude.ai
```
