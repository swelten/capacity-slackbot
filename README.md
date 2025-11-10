## capacity-slackbot

capacity-slackbot is an AWS Lambda Slack bot that posts a weekly reminder every Monday at 10:00 (configured in EventBridge) asking for each team member's capacity for the previous week. The bot automatically sends each active (non-bot) user a direct message so you can track capacity per person. Users reply with a number (e.g. `68%`), the bot acknowledges the entry, and it optionally mirrors the result into a summary channel.

### Repository structure

- `Dockerfile` – builds a Lambda container image (`public.ecr.aws/lambda/nodejs:20`) and executes `src/index.handler`.
- `src/index.js` – Lambda handler that serves both Slack event callbacks (via Bolt) and EventBridge schedule invocations.
- `slack-manifest.yml` – Slack app configuration (slash command `/capacity-ping`, event subscriptions, interactivity endpoints) for capacity-slackbot.
- `workflows/deploy.yml` – GitHub Actions workflow that builds and pushes the capacity-slackbot container image into ECR.

### Environment variables

| Variable | Description |
| --- | --- |
| `SLACK_SIGNING_SECRET` | Slack app signing secret for verifying incoming requests. |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) used for posting messages and responding to users. |
| `CAPACITY_TARGETS` | (Optional) Comma-separated list of Slack IDs. Use channel IDs (`C…`/`G…`) or user IDs (`U…`) to limit who receives prompts. When omitted, the bot automatically DM’s every active (non-bot) user in the workspace using the `users:read` scope. |
| `CAPACITY_SUMMARY_CHANNEL` | Optional channel ID that receives a summary message for each reported capacity. |

### How per-user prompts work

- During each scheduled run the Lambda function calls `users.list` to collect all workspace members.
- Deleted users, bots, and `USLACKBOT` are filtered out so only real, active teammates receive a prompt.
- For every target user the bot opens/uses the existing DM and posts the weekly capacity reminder.
- You can override this behavior by specifying `CAPACITY_TARGETS` to restrict the recipients to a subset of IDs (channels or individuals).

### Scheduling

Create or update an EventBridge rule that targets the Lambda function with the cron expression `cron(0 10 ? * MON *)` to fire every Monday at 10:00 (UTC by default). The Lambda handler automatically distinguishes scheduled invocations (`aws.events`) from Slack requests and sends the reminder DM to every target declared in `CAPACITY_TARGETS`.

You can also trigger the reminder manually inside Slack via `/capacity-ping`. The slash command hits the same Lambda endpoint, which acknowledges the command and immediately calls the reminder logic.

### Local validation

```bash
npm install
npm run check
```

To simulate the Monday reminder locally you can invoke the handler with a mock scheduled event:

```bash
node -e "require('./src/index').handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' })"
```

Make sure the required environment variables are exported before running the script.
