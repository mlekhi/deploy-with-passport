# deploy-with-passport

Deploy a static site to Vercel and put it behind your own identity provider using [Vercel Passport](https://vercel.com/docs). The script deploys the contents of  `site/`, creates an OAuth/OIDC **Connect connector**, and patches the project's passport settings via the Vercel REST API.

## Setup path

### 1. Add VERCEL_ACCESS_TOKEN

A Passport connection and the project it is active on should be in the same team. Pick a team on Vercel, scope `VERCEL_ACCESS_TOKEN` to it, and set `VERCEL_TEAM_ID`/`VERCEL_TEAM_SLUG` in `.env.local`.

### 2. Create the OIDC app

In an IdP where you have **admin**, register a new **OIDC web application**:

- **Redirect / callback URI:** `https://connect.vercel.com/callback`
- **Scopes:** `openid`, `email`, `profile`
- Copy the **Client ID** and **Client Secret** to add to the project's `.env.local`.

### 3. Fill `CONNECTOR_DATA`

Set `serverUrl` + all `serverConfig` endpoints to your org (grab them from the discovery URL above) and paste in the `clientId`/`clientSecret`.

### 4. Deploy

```bash
npm run deploy
```

Avoid re-running as it creates duplicate connectors and, if the name collides, extra projects under the team.

### 5. Assign the connection to the project

To turn on auth, visit the **Vercel Dashboard**:
