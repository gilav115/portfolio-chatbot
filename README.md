# Portfolio Chatbot

A chat widget for your website. Visitors ask about your work, services, and availability. The bot answers only from what you write about yourself: nothing invented, nothing off-topic.

Works on any website by pasting one line of code. No backend to maintain. Runs free on Cloudflare.

Setup takes about 15 minutes.


## Quick start

Replace `YOUR_USERNAME` with your GitHub username after forking this repository to your account.

```bash
git clone https://github.com/YOUR_USERNAME/portfolio-chatbot.git
cd portfolio-chatbot
bash scripts/setup.sh
```

The setup wizard walks you through every setting, checks your Cloudflare connection, guides you through storing your API key, and offers to deploy when finished. Everything is saved to `setup/config.json` on your machine (never committed).

Run it again any time to update a setting.


## Everything you configure lives in one folder

```
setup/
  config.json     your settings (name, contact methods, colours)
  about.md        who you are and what you do
  contact.md      how visitors can reach you
  services.md     what you offer (optional)
  ...
```

You fill in the `setup/` folder. The rest is code you do not need to touch.


## Before you start

You need:

* A Cloudflare account (free tier is enough). Sign up at cloudflare.com.
* An API key from OpenAI or Anthropic. See [Getting an API key](#getting-an-api-key) below.
* Node.js 18 or newer. Check by running `node --version` in your terminal.
* Python 3. Check by running `python3 --version`. Comes preinstalled on macOS and most Linux systems.


## Step 1: Download

Replace `YOUR_USERNAME` with your GitHub username after forking this repository to your account.

```bash
git clone https://github.com/YOUR_USERNAME/portfolio-chatbot.git
cd portfolio-chatbot
```


If you used the Quick Start wizard above, you can skip Steps 2, 3, and 4: the wizard handles them automatically. These steps are for manual setup or if you want to understand what happens under the hood.


## Step 2: Connect to Cloudflare

```bash
cd worker && npx wrangler login
```

This opens a browser tab. Log in to your Cloudflare account and click Authorize. This grants Wrangler permission to create and deploy Workers in your account. You only do this once.


## Step 3: Store your API key

If you do not have an API key yet, see [Getting an API key](#getting-an-api-key) below first.

```bash
cd worker && npx wrangler secret put LLM_API_KEY
```

Paste your API key when prompted and press Enter. Wrangler sends it to Cloudflare, where it is encrypted and stored securely. It is never in your code or files and cannot be read back: not even by you.


## Step 4: Create a widget token

```bash
cd worker && npx wrangler secret put WIDGET_TOKEN
```

Make up any long random string, at least 20 characters. Write it down: you will paste it into your website later. Or generate one:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(18))"
```


## Step 5: Fill in your details

If `setup/config.json` does not exist yet, copy it from `setup/examples/config.json` first.

Open `setup/config.json` in any text editor. Fill in at minimum:

```json
{
  "botName": "Sarah's Bot",
  "ownerName": "Sarah Johnson",
  "contactMethods": {
    "email": "hello@yourdomain.com",
    "linkedin": "https://linkedin.com/in/yourhandle"
  },
  "security": {
    "allowedOrigins": [
      "https://yourdomain.com",
      "https://www.yourdomain.com"
    ]
  }
}
```

`allowedOrigins` must match your website's domain exactly: include both the `www` and non-`www` versions. Requests from other domains will be blocked. **If you leave this empty when you go live, anyone on the internet can query your worker and run up your API costs.** Only leave it empty during local development.

Then open `setup/about.md` and write about yourself. The more accurate and complete, the better the bot performs. Open `setup/contact.md` and describe how and when visitors should reach you.

See [All configuration options](#all-configuration-options) and [Profile files](#profile-files) below for everything you can set.


## Step 6: Deploy

```bash
bash scripts/build-and-deploy.sh
```

The script handles everything automatically:

1. Installs worker dependencies if not already installed
2. Copies example files into `setup/` if any are missing, so you can edit them
3. Checks Cloudflare authentication and tells you what to do if not connected
4. Checks that LLM_API_KEY and WIDGET_TOKEN are set and guides you if not
5. Reads all `.md` files from `setup/` and combines them into your profile
6. Uploads your profile and config to Cloudflare as encrypted secrets (they never go into git)
7. Deploys the worker to Cloudflare's global network

When it finishes, look for a line in the output like this:

```
https://portfolio-chatbot-worker.YOUR-NAME.workers.dev
```

Copy that URL. You need it in the next step.

**Updating later:** whenever you edit files in `setup/`, run `bash scripts/build-and-deploy.sh` again. The worker is updated live within about 30 seconds.


## Step 7: Host the widget file

The chat widget is a single JavaScript file: `widget/widget.js`. Your visitors' browsers download it when your page loads, so it needs to be publicly accessible.

**Cloudflare Pages: free and simplest:**

1. Go to dash.cloudflare.com
2. Click Workers and Pages, then Create, then Pages, then Upload assets
3. Give the project a name: for example `my-widget`
4. Upload only the `widget/widget.js` file from this project
5. Click Deploy

You get a URL like `https://my-widget.pages.dev/widget.js`. Copy it. To verify it works, open the URL in a browser: you should see JavaScript source code.

You can also place `widget.js` in your own website's static files folder if you have one, and link to it from there.


## Step 8: Add the widget to your website

Open any HTML page on your website. Find the `</body>` tag near the bottom of the file. Paste this snippet immediately before it:

```html
<script
  src="WIDGET_JS_URL"
  data-worker="WORKER_URL"
  data-token="YOUR_WIDGET_TOKEN"
  data-name="Sarah's Bot"
  data-accent="#0055ff"
  data-welcome="Hi! Ask me anything about my work."
></script>
```

Replace each placeholder:

| Placeholder | What to use |
|---|---|
| `WIDGET_JS_URL` | URL from Step 7, e.g. `https://my-widget.pages.dev/widget.js` |
| `WORKER_URL` | URL from Step 6, e.g. `https://portfolio-chatbot-worker.YOUR-NAME.workers.dev` |
| `YOUR_WIDGET_TOKEN` | The token you created in Step 4 |
| `data-name` | Name displayed in the chat header |
| `data-accent` | Accent colour as a hex code |
| `data-welcome` | First message visitors see when they open the widget |

Save the file and publish your website. The widget appears as a floating button in the bottom-right corner of the page.


## Getting an API key

**OpenAI (default):**
Log in at platform.openai.com, go to API keys, and create a new secret key. The default model is `gpt-4o-mini`: cheap and fast.

**Anthropic Claude:**
Log in at console.anthropic.com, go to API keys, and create a key. To use it, set `"llm": { "provider": "anthropic" }` in your `setup/config.json`. The default model is `claude-haiku-4-5-20251001`.

Both work equally well for this use case. If you are not sure, start with OpenAI.


## Profile files

All files in `setup/` are gitignored: they stay on your machine and are never committed. See `setup/examples/` for filled-in examples using a fictional persona.

| File | What to write |
|---|---|
| `about.md` | Who you are, background, career history: required |
| `contact.md` | Contact methods, when and how to use them: required |
| `services.md` | What you offer, who you work with |
| `experience.md` | Roles, industries, tools, years of experience |
| `faq.md` | Questions you get asked often, pre-answered |
| `boundaries.md` | Topics the bot must never claim or discuss |

Any additional `.md` files you add to `setup/` are included automatically on the next deploy.


## All configuration options

Edit `setup/config.json`. All fields except `botName` and `ownerName` have defaults and can be omitted.

**Identity**

| Field | Default | Description |
|---|---|---|
| `botName` | `"Assistant"` | Name shown in the widget header |
| `ownerName` | `"the professional"` | Used in the bot's replies and fallback messages |
| `tone` | `"professional"` | Writing style: `professional` `casual` `direct` `warm` `technical` `formal` `founder` |
| `maxAnswerWords` | `80` | Target reply length in words |
| `historyTurns` | `4` | How many previous message pairs the bot remembers in one session |
| `allowedTopics` | `[]` | Keywords the bot is allowed to discuss. Empty means allow anything from the profile. |
| `blockedTopics` | `[personal life, politics, ...]` | Keywords the bot will refuse. Setting this replaces the default list entirely. |

**Contact methods**

All optional. Only the methods you configure get shown as buttons.

| Field | Example | Notes |
|---|---|---|
| `contactMethods.email` | `"hello@yoursite.com"` | |
| `contactMethods.linkedin` | `"https://linkedin.com/in/yourhandle"` | Full URL |
| `contactMethods.whatsapp` | `"447000000000"` | Country code + number, digits only |
| `contactMethods.sms` | `"447000000000"` | Same format as WhatsApp |
| `contactMethods.calendar` | `"https://cal.com/yourname/intro"` | Full URL to your booking page |
| `contactMethods.github` | `"https://github.com/yourhandle"` | Full URL |
| `contactMethods.custom` | `[{ "label": "Portfolio", "href": "https://..." }]` | Any extra links |

**LLM provider**

| Field | Default | Description |
|---|---|---|
| `llm.provider` | `"openai"` | `openai` or `anthropic` |
| `llm.model` | `null` | Leave null to use the provider default. OpenAI: `gpt-4o-mini`. Anthropic: `claude-haiku-4-5-20251001`. |

**Security**

| Field | Default | Description |
|---|---|---|
| `security.allowedOrigins` | `[]` | Domains allowed to use your worker. Empty means no restriction: not recommended. |
| `security.rateLimitRpm` | `10` | Max requests per visitor per minute |
| `security.maxMessageLength` | `500` | Max characters in a visitor message |
| `security.maxSessionMessages` | `20` | Max messages per visitor per session |

**Lead capture**

| Field | Default | Description |
|---|---|---|
| `leadCapture.enabled` | `false` | Whether to prompt visitors to leave contact details |
| `leadCapture.trigger` | `"on_intent"` | When to prompt: `on_intent` activates when interest is detected |

**Widget appearance**

| Field | Default | Description |
|---|---|---|
| `ui.accentColor` | `"#0055ff"` | Button and icon colour |
| `ui.welcomeMessage` | auto | First message the visitor sees |
| `ui.suggestedQuestions` | `[]` | Quick-reply buttons shown below the welcome message |


## Local development

Start the worker locally:

```bash
cd worker && npm run dev
```

The worker runs at `http://localhost:8787`. Open `widget/index.html` in a browser to test the widget against it.

To test with your real `setup/` files locally:

```bash
export BOT_CONFIG_JSON="$(cat setup/config.json)"
export PROFILE_TEXT="$(cat setup/*.md 2>/dev/null)"
cd worker && npm run dev
```

When running locally, the widget token and origin checks are skipped if the secrets are not set: so you can test freely without configuring them.


## Security model

* All secrets are encrypted Cloudflare Worker secrets: never in source code or git history
* `WIDGET_TOKEN` blocks direct API calls that do not come from your widget
* `allowedOrigins` blocks browser requests from domains other than yours
* Every visitor message is validated before reaching the AI: size, injection patterns, topic keywords
* The system prompt enforces strict context boundaries as a second layer
* Replies are sanitised and length-capped before being sent back to the visitor
* Conversation history is in memory only: never logged, never persisted


## Cost

* Cloudflare Workers free tier: 100,000 requests per day
* Cloudflare Pages: free for hosting `widget.js`
* OpenAI gpt-4o-mini: roughly $0.01 per 1,000 messages
* Anthropic claude-haiku: similar cost range

A personal site with a few hundred visitors per day costs essentially nothing to run.


## Project structure

```
portfolio-chatbot/
  setup/
    examples/       filled-in example files (fictional persona, safe to share)
    config.json     your config (gitignored)
    about.md        your profile files (gitignored)
    ...
  worker/
    src/
      index.js      routing, LLM calls, CTA logic
      config.js     config loading and defaults
      prompt.js     system prompt builder
      guards.js     input validation and output sanitisation
    package.json
    wrangler.toml
  widget/
    widget.js       the embeddable chat widget (Shadow DOM, no dependencies)
    index.html      local dev test page
  scripts/
    build-and-deploy.sh
  README.md
```
