# Climb

Learn any topic through short, visual lessons that start easy and get harder as you improve. Powered by Claude.

## How it works

- `public/index.html` is the whole app: course building, interactive teaching cards, diagrams, the 5-level question ladder, spacing and branching.
- `public/claude-shim.js` connects the app to this site's own server. Progress is saved in the visitor's browser for now (accounts come in version 2).
- `src/worker.js` is the server (a Cloudflare Worker). It serves the app and relays requests to the Claude API at `/api/sample`. The API key never reaches the browser. `/api/syllabus` looks up official SEAB syllabuses for subjects that aren't ready-made (cached in D1).
- `public/syllabi.json` holds ready-made, checked summaries of 28 official syllabuses (PSLE, SEC G3 2027, A-Level 2027), each linking to its official PDF. Refreshed twice a year.
- Protection: only this site's pages may call the API, each visitor is limited to 20 Claude requests per minute, prompts and replies are size-capped, and only Climb's four allowed models can be used. The real ceiling on cost is the spending limit you set in the Claude Console.

## Set up (one time)

1. **Claude Console** (platform.claude.com): add billing, set a monthly spend limit, create a workspace called `Climb` with its own spend limit, and create an API key in it.
2. **Cloudflare dashboard** → Workers & Pages → Create application → Import a repository → pick `Drava999/climb`. Keep the Worker name `climb`, the build command empty and the deploy command `npx wrangler deploy`. Save and deploy.
3. In the new Worker → Settings → Variables and Secrets → Add → type **Secret**, name `ANTHROPIC_API_KEY`, value = your key. Save (this redeploys).
4. Open the `climb.<your-subdomain>.workers.dev` address. `/api/health` should show `"claude": true`.

Every push to `main` redeploys automatically.

## Run locally

```
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars
npx wrangler dev
```

## Roadmap

1. ✅ App + server + per-visitor rate limit on a workers.dev address
2. Accounts and progress saved to a database (Cloudflare D1), shared course library
3. Move prompts onto the server, per-account daily quotas and a daily budget switch, question quality-check pass, "Report this question"
4. Beta with 10–20 people
5. Own domain, privacy policy, paid tier
