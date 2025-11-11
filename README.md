## capacity-slackbot

capacity-slackbot is an AWS Lambda Slack app that reminds every teammate to submit their weekly capacity and writes the answers into Notion. Each reminder DM contains a “Kapazität melden” button that starts a guided DM conversation. The bot sequentially asks for:

1. Auto-fills the **Name** property with the current ISO calendar week (`KW XX`) and stores the Monday–Sunday range in the `Woche` date field.
2. Lets the user choose themselves from the Notion people list (`Person`) and enter contractual hours (`Verfügbar`).
3. Collects hours for the mandatory business areas (Marketing, Management, Akquise, Finanzen, HR, Study, Regelmäßige Aufgaben/Mails) based on a multi-select choice.
4. Asks whether the user is a developer; if yes, it requests hours for `Dev-DeepWaive`, `Dev-General`, `Dev-Platform`, and `Dev-Website`.
5. Offers a multi-select of all projects from the “Alle Projekte Database” and captures the worked hours per project. The first project is saved on the base entry, further projects create additional `KW XX (1)`, `KW XX (2)`, … pages that point to the same week and person.

### Repository structure

- `Dockerfile` – builds a Lambda container image (`public.ecr.aws/lambda/nodejs:20`) and executes `src/index.handler`.
- `src/index.js` – Lambda entrypoint containing Slack Bolt handlers, Notion helpers, the conversational workflow, and the EventBridge scheduler hook.
- `slack-manifest.yml` – Slack app definition (`/capacity-ping` slash command, message actions, interactivity URLs) that must point to the deployed Lambda Function URL.
- `workflows/deploy.yml` – GitHub Actions workflow that validates sources and pushes the Lambda container to ECR.

### Environment variables

| Variable | Description |
| --- | --- |
| `SLACK_SIGNING_SECRET` | Slack signing secret used by Bolt’s `AwsLambdaReceiver`. |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) with `chat:write`, `commands`, `im:*`, `channels:read`, `users:read`. |
| `CAPACITY_TARGETS` | *(Optional)* Comma-separated Slack IDs (user/channel) to limit who receives the Monday DM. Omit to ping every active human in the workspace. |
| `CAPACITY_TIMEZONE` | *(Optional)* IANA timezone used when writing the Monday–Sunday range to Notion. Defaults to `Europe/Berlin`. |
| `NOTION_API_TOKEN` | Internal integration token with access to both Notion databases. |
| `NOTION_CAPACITY_DB_ID` | Database ID of “Kapazitätsplan Alle Database (NEU)” (where weekly entries are stored). |
| `NOTION_PROJECTS_DB_ID` | Database ID of “Alle Projekte Database” used to populate the project multi-select. |

> ⚠️ The Notion databases must be shared with the integration connected to `NOTION_API_TOKEN`.

### Slack interactions

- **Scheduled DM** – Every Monday at 10:00 (via EventBridge) the bot DM’s each target user with the reminder text and button. Clicking the button starts the guided DM chat.
- **`/capacity-ping` slash command** – Without arguments it starts the same chat for the command user (handy for ad-hoc edits). Run `/capacity-ping broadcast` to trigger the reminder DM immediately for everyone (mirrors the EventBridge run).
- **Chat flow** – The bot walks each user through the same three logical steps (base data → task/category hours → project hours) inside the DM. Every answer is captured in real time; once the last question is answered the entry is written to Notion, extra project pages are created/archived as needed, and the user receives a confirmation DM.

### Scheduling

- Create an EventBridge rule with `cron(0 10 ? * MON *)` (10:00 UTC, adjust as needed) and set the Lambda function as the target. Each invocation gathers the current workspace users (or `CAPACITY_TARGETS`) and sends the DM with the chat button.
- You can manually fire the same logic via `/capacity-ping broadcast` if you need to re-run the reminder outside the schedule.

### Local validation

```bash
npm install
npm run check
```

To simulate the Monday reminder locally you can invoke the handler with a mock scheduled event:

```bash
node -e "require('./src/index').handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' })"
```

> Make sure all Slack and Notion environment variables are exported before running the script locally, otherwise the handler will throw during initialization.
