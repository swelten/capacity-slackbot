const { App, AwsLambdaReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;

const awsLambdaReceiver = signingSecret
  ? new AwsLambdaReceiver({ signingSecret })
  : null;

const app = awsLambdaReceiver
  ? new App({
      token: botToken,
      receiver: awsLambdaReceiver,
      processBeforeResponse: true,
    })
  : null;

const slackClient = botToken ? new WebClient(botToken) : null;

const configuredTargets = (process.env.CAPACITY_TARGETS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const summaryChannel = process.env.CAPACITY_SUMMARY_CHANNEL;

const PROMPT_TEXT =
  'Happy Monday! Please share your capacity (% of availability) for last week.';

function parseCapacityValue(text = '') {
  const match = text.match(/(\d{1,3})(?:\s?%| percent| prozent)?/i);
  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);
  if (Number.isNaN(value)) {
    return null;
  }

  return Math.min(Math.max(value, 0), 200);
}

async function resolveChannelId(target) {
  if (!slackClient) {
    throw new Error('Slack client not configured.');
  }

  if (/^[CG][A-Z0-9]+$/i.test(target)) {
    return target;
  }

  if (/^U[A-Z0-9]+$/i.test(target)) {
    const response = await slackClient.conversations.open({
      users: target,
    });

    return response?.channel?.id;
  }

  throw new Error(
    `Unsupported CAPACITY_TARGET entry "${target}". Use Slack user or channel IDs.`
  );
}

async function listWorkspaceMembers() {
  if (!slackClient) {
    throw new Error('Missing SLACK_BOT_TOKEN for user discovery.');
  }

  const members = [];
  let cursor;
  do {
    const response = await slackClient.users.list({
      limit: 200,
      cursor,
    });

    for (const member of response.members || []) {
      if (member.deleted || member.is_bot || member.id === 'USLACKBOT') {
        continue;
      }

      members.push(member.id);
    }

    cursor = response.response_metadata?.next_cursor;
  } while (cursor);

  return members;
}

async function getPromptTargets() {
  if (configuredTargets.length) {
    return configuredTargets;
  }

  const members = await listWorkspaceMembers();
  if (!members.length) {
    throw new Error(
      'No eligible members found. Provide CAPACITY_TARGETS or ensure workspace users exist.'
    );
  }

  return members;
}

async function sendCapacityPrompts() {
  if (!slackClient) {
    throw new Error('Missing SLACK_BOT_TOKEN for prompt sending.');
  }

  const promptTargets = await getPromptTargets();

  for (const target of promptTargets) {
    const channelId = await resolveChannelId(target);
    if (!channelId) {
      continue;
    }

    await slackClient.chat.postMessage({
      channel: channelId,
      text: PROMPT_TEXT,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Weekly capacity check*\n' + PROMPT_TEXT,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text:
                'Reply in this DM with a percentage (e.g. `65%`). ' +
                'Your answer is acknowledged automatically.',
            },
          ],
        },
      ],
    });
  }
}

async function handleCapacityResponse(event, client, logger) {
  if (event.subtype || event.bot_id || event.channel_type !== 'im') {
    return;
  }

  const capacity = parseCapacityValue(event.text);

  if (capacity === null) {
    await client.chat.postMessage({
      channel: event.channel,
      text: 'Please reply with a number like `72%` so I can log it.',
    });
    return;
  }

  await client.chat.postMessage({
    channel: event.channel,
    text: `Thanks <@${event.user}> — recorded *${capacity}%* capacity for last week.`,
  });

  if (summaryChannel) {
    await client.chat.postMessage({
      channel: summaryChannel,
      text: `<@${event.user}> reported *${capacity}%* capacity for last week.`,
    });
  }

  logger?.info?.({
    msg: 'Capacity response stored',
    user: event.user,
    capacity,
  });
}

function isScheduledEvent(event = {}) {
  return (
    event.source === 'aws.events' ||
    event['detail-type'] === 'Scheduled Event' ||
    event.trigger === 'capacity-cron'
  );
}

if (app) {
  app.event('message', async ({ event, client, logger }) => {
    await handleCapacityResponse(event, client, logger);
  });
}

const slackHandler = awsLambdaReceiver ? awsLambdaReceiver.start() : null;

async function handler(event, context, callback) {
  if (isScheduledEvent(event)) {
    await sendCapacityPrompts();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  }

  if (!slackHandler) {
    throw new Error('Slack handler not configured.');
  }

  return slackHandler(event, context, callback);
}

module.exports = {
  handler,
  parseCapacityValue,
};
