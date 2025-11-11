const { App, AwsLambdaReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { Client: NotionClient } = require('@notionhq/client');
const { DateTime } = require('luxon');

let AWS;
try {
  AWS = require('aws-sdk');
} catch {
  AWS = null;
}

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;

const notionToken = process.env.NOTION_API_TOKEN;
const notionCapacityDbId = process.env.NOTION_CAPACITY_DB_ID;
const notionProjectsDbId = process.env.NOTION_PROJECTS_DB_ID;
const timezone = process.env.CAPACITY_TIMEZONE || 'Europe/Berlin';
const conversationTable = process.env.CONVERSATION_TABLE || '';
const conversationTtlSeconds =
  Number.parseInt(process.env.CONVERSATION_TTL_SECONDS || '', 10) || 3600;

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
const notionClient = notionToken ? new NotionClient({ auth: notionToken }) : null;
if (conversationTable && !AWS) {
  throw new Error(
    'aws-sdk module is required when CONVERSATION_TABLE is set. Install aws-sdk or remove the env var.'
  );
}
const dynamoClient =
  conversationTable && AWS ? new AWS.DynamoDB.DocumentClient() : null;

const configuredTargets = (process.env.CAPACITY_TARGETS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const PROMPT_BUTTON_ACTION = 'open_capacity_modal';
const PROMPT_TEXT =
  'Please log your capacity for the current calendar week. Click the button below to answer the questions.';

const ACTION_IDS = {
  PERSON: 'conversation_select_person',
  MANDATORY: 'conversation_select_mandatory_single',
  DEVELOPER: 'conversation_select_developer',
  PROJECTS: 'conversation_select_project_single',
};

const SELECT_SPECIAL_VALUES = {
  DONE: '__done__',
  CLEAR: '__clear__',
};

const MANDATORY_FIELDS = [
  { id: 'Marketing', label: 'Marketing' },
  { id: 'Management', label: 'Management' },
  { id: 'Akquise', label: 'Akquise' },
  { id: 'Finanzen', label: 'Finanzen' },
  { id: 'HR', label: 'HR' },
  { id: 'Study', label: 'Study' },
  { id: 'Regelmäßige Aufgaben(Mails...)', label: 'Regelmäßige Aufgaben (Mails, etc.)' },
];

const DEVELOPER_FIELDS = [
  { id: 'Dev-DeepWaive', label: 'DeepWaive' },
  { id: 'Dev-General', label: 'General / Misc' },
  { id: 'Dev-Platform', label: 'Platform' },
  { id: 'Dev-Website', label: 'Website' },
];

const activeConversations = new Map();

const mandatoryFieldLabels = new Map(
  MANDATORY_FIELDS.map((field) => [field.id, field.label])
);
const developerFieldLabels = new Map(
  DEVELOPER_FIELDS.map((field) => [field.id, field.label])
);

function getConversationTtl() {
  const base = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(conversationTtlSeconds)
    ? conversationTtlSeconds
    : 3600;
  return base + Math.max(ttl, 300);
}

async function loadConversation(channelId) {
  if (!channelId) {
    return null;
  }

  const cached = activeConversations.get(channelId);
  if (cached) {
    return cached;
  }

  if (!dynamoClient) {
    return null;
  }

  const response = await dynamoClient
    .get({
      TableName: conversationTable,
      Key: { channelId },
    })
    .promise();

  const state = response.Item?.state;
  if (!state) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(state);
  } catch {
    return null;
  }

  parsed.channelId = channelId;
  activeConversations.set(channelId, parsed);
  return parsed;
}

async function saveConversation(conversation) {
  if (!conversation || !conversation.channelId) {
    return;
  }

  activeConversations.set(conversation.channelId, conversation);
  if (!dynamoClient) {
    return;
  }

  const payload = JSON.stringify(conversation);
  await dynamoClient
    .put({
      TableName: conversationTable,
      Item: {
        channelId: conversation.channelId,
        state: payload,
        expiresAt: getConversationTtl(),
      },
    })
    .promise();
}

async function deleteConversationState(channelId) {
  if (!channelId) {
    return;
  }

  activeConversations.delete(channelId);
  if (!dynamoClient) {
    return;
  }

  await dynamoClient
    .delete({
      TableName: conversationTable,
      Key: { channelId },
    })
    .promise();
}

function assertSlackClient() {
  if (!slackClient) {
    throw new Error('Slack client not configured.');
  }
}

function assertNotionConfig() {
  if (!notionClient || !notionCapacityDbId) {
    throw new Error(
      'Notion is not configured. Set NOTION_API_TOKEN and NOTION_CAPACITY_DB_ID.'
    );
  }
}

function getWeekBounds(referenceDate = DateTime.now().setZone(timezone)) {
  let base =
    referenceDate instanceof Date
      ? DateTime.fromJSDate(referenceDate).setZone(timezone)
      : referenceDate.setZone(timezone);

  if (!base.isValid) {
    base = DateTime.now().setZone('UTC');
  }

  const target = base.minus({ weeks: 1 });

  const monday = target.minus({ days: target.weekday - 1 }).startOf('day');
  const sunday = monday.plus({ days: 6 }).endOf('day');
  const weekNumber = target.weekNumber;

  return {
    weekNumber,
    weekName: `KW ${String(weekNumber).padStart(2, '0')}`,
    start: monday.toISODate(),
    end: sunday.toISODate(),
  };
}

async function resolveChannelId(target) {
  assertSlackClient();

  if (/^[CG][A-Z0-9]+$/i.test(target)) {
    return target;
  }

  if (/^U[A-Z0-9]+$/i.test(target)) {
    const response = await slackClient.conversations.open({ users: target });
    return response?.channel?.id;
  }

  throw new Error(
    `Unsupported CAPACITY_TARGET entry "${target}". Use Slack user or channel IDs.`
  );
}

async function listWorkspaceMembers() {
  assertSlackClient();

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
  assertSlackClient();
  const promptTargets = await getPromptTargets();
  const weekInfo = getWeekBounds();

  for (const target of promptTargets) {
    const channelId = await resolveChannelId(target);
    if (!channelId) {
      continue;
    }

    await slackClient.chat.postMessage({
      channel: channelId,
      text: `${PROMPT_TEXT} (${weekInfo.weekName})`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${weekInfo.weekName}*\n${PROMPT_TEXT}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
            text: `Range: ${weekInfo.start} to ${weekInfo.end}`,
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Start capacity chat' },
              action_id: PROMPT_BUTTON_ACTION,
              value: JSON.stringify({
                weekName: weekInfo.weekName,
              }),
            },
          ],
        },
      ],
    });
  }
}

async function fetchNotionPeople() {
  assertNotionConfig();
  const people = [];
  let cursor;
  do {
    const response = await notionClient.users.list({ start_cursor: cursor });
    for (const user of response.results || []) {
      if (user.type !== 'person') {
        continue;
      }

      people.push({
        id: user.id,
        name: user.name || user.person?.email || 'Unbenannt',
        email: user.person?.email,
      });
    }

    cursor = response.next_cursor;
  } while (cursor && people.length < 100);

  return people.slice(0, 100);
}

async function fetchProjects(limit = 100) {
  assertNotionConfig();
  if (!notionProjectsDbId) {
    throw new Error('NOTION_PROJECTS_DB_ID is not configured.');
  }

  const projects = [];
  let cursor;
  do {
    const response = await notionClient.databases.query({
      database_id: notionProjectsDbId,
      start_cursor: cursor,
      page_size: Math.min(100, limit - projects.length),
      sorts: [
        {
          property: 'Name',
          direction: 'ascending',
        },
      ],
    });

    for (const entry of response.results || []) {
      const titleProperty = entry.properties?.Name;
      const title =
        titleProperty?.title?.map((part) => part.plain_text).join('') ||
        'Unbenannt';

      if (!/^P[A-Z0-9]{5}/.test(title)) {
        continue;
      }

      projects.push({
        id: entry.id,
        name: title,
      });
    }

    cursor = response.next_cursor;
  } while (cursor && projects.length < limit);

  return projects;
}

async function findBaseEntry(personId, weekName) {
  assertNotionConfig();

  const response = await notionClient.databases.query({
    database_id: notionCapacityDbId,
    filter: {
      and: [
        {
          property: 'Person',
          people: {
            contains: personId,
          },
        },
        {
          property: 'Name',
          title: {
            equals: weekName,
          },
        },
      ],
    },
    page_size: 1,
  });

  return response.results?.[0] || null;
}

async function createBaseEntry({ personId, weekInfo }) {
  assertNotionConfig();

  const properties = {
    Name: {
      title: [
        {
          type: 'text',
          text: { content: weekInfo.weekName },
        },
      ],
    },
    Person: {
      people: [{ id: personId }],
    },
    Woche: {
      date: {
        start: weekInfo.start,
        end: weekInfo.end,
      },
    },
  };

  const response = await notionClient.pages.create({
    parent: { database_id: notionCapacityDbId },
    properties,
  });

  return response;
}

async function ensureBaseEntry({ personId, weekInfo }) {
  let page = await findBaseEntry(personId, weekInfo.weekName);
  if (page) {
    return page;
  }

  page = await createBaseEntry({ personId, weekInfo });
  return page;
}

function normaliseOptionLabel(text) {
  return (text || 'Unbenannt').slice(0, 75);
}

function getFieldLabel(fieldMap, id) {
  return fieldMap.get(id) || id;
}

async function ensureDmChannel(userId, preferredChannelId = null) {
  if (preferredChannelId && preferredChannelId.startsWith('D')) {
    return preferredChannelId;
  }

  const dm = await slackClient.conversations.open({ users: userId });
  if (!dm?.channel?.id) {
    throw new Error('Unable to open a DM channel.');
  }
  return dm.channel.id;
}

async function notifyStaleConversation(userId, channelId) {
  try {
    const targetChannel = channelId || (await ensureDmChannel(userId));
    await slackClient.chat.postMessage({
      channel: targetChannel,
      text: 'This capacity session expired. Run /capacity-ping to start again.',
    });
  } catch {
    // Ignore notification errors.
  }
}

async function startCapacityConversation({ userId, channelId }) {
  assertSlackClient();
  assertNotionConfig();

  const dmChannelId = await ensureDmChannel(userId, channelId);
  await deleteConversationState(dmChannelId);

  let people;
  let projects;
  try {
    [people, projects] = await Promise.all([fetchNotionPeople(), fetchProjects()]);
  } catch (error) {
    await slackClient.chat.postMessage({
      channel: dmChannelId,
      text: 'Unable to load Notion data. Please try again in a moment.',
    });
    throw error;
  }

  if (!people.length) {
    await slackClient.chat.postMessage({
      channel: dmChannelId,
      text: 'No Notion users were found. Please share the database with the integration.',
    });
    return;
  }

  const weekInfo = getWeekBounds();
  const conversation = {
    userId,
    channelId: dmChannelId,
    weekInfo,
    people,
    projects,
    personId: null,
    contractHours: null,
    mandatorySelections: [],
    mandatoryValues: {},
    isDeveloper: false,
    developerValues: {},
    projectsSelected: [],
    projectHours: {},
    currentMandatoryIndex: 0,
    currentDeveloperIndex: 0,
    currentProjectIndex: 0,
    state: 'awaiting_person',
  };

  await saveConversation(conversation);

  await slackClient.chat.postMessage({
    channel: dmChannelId,
    text: `Let's log your capacity for ${weekInfo.weekName}.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Let's log your capacity for *${weekInfo.weekName}* (${weekInfo.start} – ${weekInfo.end}). Type *cancel* anytime to stop.`,
        },
      },
    ],
  });

  await promptPersonSelection(conversation);
}

async function promptPersonSelection(conversation) {
  conversation.state = 'awaiting_person';
  await saveConversation(conversation);
  const options = conversation.people.map((person) => ({
    text: {
      type: 'plain_text',
      text: normaliseOptionLabel(person.name),
    },
    value: person.id,
  }));

  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: 'Select the person for this entry.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Who is submitting this capacity entry?',
        },
        accessory: {
          type: 'static_select',
          action_id: ACTION_IDS.PERSON,
          placeholder: {
            type: 'plain_text',
            text: 'Select person',
          },
          options,
        },
      },
    ],
  });
}

async function promptContractHours(conversation) {
  conversation.state = 'awaiting_contract_hours';
  await saveConversation(conversation);
  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text:
      'How many hours did you work this week? Send a number like 40 or 32.5.',
  });
}

async function promptMandatorySelection(conversation) {
  conversation.state = 'awaiting_mandatory_selection';
  await saveConversation(conversation);
  const selectedLabels = conversation.mandatorySelections.map((id) =>
    getFieldLabel(mandatoryFieldLabels, id)
  );

  const availableOptions = MANDATORY_FIELDS.filter(
    (field) => !conversation.mandatorySelections.includes(field.id)
  ).map((field) => ({
    text: { type: 'plain_text', text: field.label },
    value: field.id,
  }));

  const specialOptions = [
    {
      text: { type: 'plain_text', text: 'Done selecting' },
      value: SELECT_SPECIAL_VALUES.DONE,
    },
    {
      text: { type: 'plain_text', text: 'Clear selections' },
      value: SELECT_SPECIAL_VALUES.CLEAR,
    },
  ];

  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: 'Select the business areas you worked in.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Select every business area you contributed to this week.\nUse the dropdown to add one area at a time, then choose *Done selecting* when finished. Type *none* to skip.',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: selectedLabels.length
              ? `Current selection: ${selectedLabels.join(', ')}`
              : 'No areas selected yet.',
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'static_select',
            action_id: ACTION_IDS.MANDATORY,
            placeholder: {
              type: 'plain_text',
              text: 'Add an area',
            },
            options: [...availableOptions, ...specialOptions],
          },
        ],
      },
    ],
  });
}

async function promptNextMandatoryHours(conversation) {
  const fieldId = conversation.mandatorySelections[conversation.currentMandatoryIndex];
  if (!fieldId) {
    await promptDeveloperQuestion(conversation);
    return;
  }

  conversation.state = 'awaiting_mandatory_hours';
  await saveConversation(conversation);
  const label = getFieldLabel(mandatoryFieldLabels, fieldId);
  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: `How many hours did you spend on *${label}*? Reply with a number.`,
  });
}

async function promptDeveloperQuestion(conversation) {
  conversation.state = 'awaiting_developer_choice';
  await saveConversation(conversation);
  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: 'Are you a developer?',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Are you a developer? If yes, we will log detailed dev buckets.',
        },
        accessory: {
          type: 'static_select',
          action_id: ACTION_IDS.DEVELOPER,
          placeholder: {
            type: 'plain_text',
            text: 'Choose an option',
          },
          options: [
            { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
            { text: { type: 'plain_text', text: 'No' }, value: 'no' },
          ],
        },
      },
    ],
  });
}

async function promptNextDeveloperHours(conversation) {
  const field = DEVELOPER_FIELDS[conversation.currentDeveloperIndex];
  if (!conversation.isDeveloper || !field) {
    await promptProjectSelection(conversation);
    return;
  }

  conversation.state = 'awaiting_developer_hours';
  await saveConversation(conversation);
  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: `Hours for *${field.label}*? Reply with a number or type *skip* to keep it empty.`,
  });
}

async function promptProjectSelection(conversation) {
  conversation.state = 'awaiting_project_selection';
  await saveConversation(conversation);
  if (!conversation.projects.length) {
    await slackClient.chat.postMessage({
      channel: conversation.channelId,
      text: 'No projects found in Notion. Skipping project breakdown.',
    });
    conversation.projectsSelected = [];
    await finalizeConversation(conversation);
    return;
  }

  const projectOptions = conversation.projects.map((project) => ({
    text: { type: 'plain_text', text: normaliseOptionLabel(project.name) },
    value: project.id,
  }));

  const availableOptions = projectOptions.filter(
    (option) => !conversation.projectsSelected.find((p) => p.id === option.value)
  );
  const specialOptions = [
    {
      text: { type: 'plain_text', text: 'Done selecting projects' },
      value: SELECT_SPECIAL_VALUES.DONE,
    },
    {
      text: { type: 'plain_text', text: 'Clear selected projects' },
      value: SELECT_SPECIAL_VALUES.CLEAR,
    },
  ];

  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: 'Select the projects you worked on.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Select every project from “Alle Projekte Database” that you worked on.',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: conversation.projectsSelected.length
              ? `Current projects: ${conversation.projectsSelected
                  .map((p) => p.name)
                  .join(', ')}`
              : 'No projects selected yet. Choose *Done selecting projects* or type *none* if you did not work on any.',
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'static_select',
            action_id: ACTION_IDS.PROJECTS,
            placeholder: {
              type: 'plain_text',
              text: 'Add a project',
            },
            options: [...availableOptions, ...specialOptions],
          },
        ],
      },
    ],
  });
}

async function promptNextProjectHours(conversation) {
  const currentProject = conversation.projectsSelected[conversation.currentProjectIndex];
  if (!currentProject) {
    await finalizeConversation(conversation);
    return;
  }

  conversation.state = 'awaiting_project_hours';
  await saveConversation(conversation);
  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: `How many hours did you work on *${currentProject.name}*? Reply with a number.`,
  });
}

async function finalizeConversation(conversation) {
  conversation.state = 'saving';
  try {
    await saveCapacityToNotion({
      pageId: null,
      personId: conversation.personId,
      contractHours: conversation.contractHours,
      mandatoryValues: conversation.mandatoryValues,
      developerValues: conversation.developerValues,
      weekInfo: conversation.weekInfo,
      projects: conversation.projectsSelected,
      projectHours: conversation.projectHours,
    });
    await slackClient.chat.postMessage({
      channel: conversation.channelId,
      text: 'Capacity saved. Thank you!',
    });
  } catch (error) {
    await slackClient.chat.postMessage({
      channel: conversation.channelId,
      text: 'Saving your capacity failed. Please try again later.',
    });
    throw error;
  } finally {
    await deleteConversationState(conversation.channelId);
  }
}

async function handleNumericAnswer({
  conversation,
  text,
  onSuccess,
  allowSkip = false,
}) {
  const trimmed = text.trim();
  if (allowSkip && trimmed.toLowerCase() === 'skip') {
    await onSuccess(null);
    return;
  }

  const value = extractNumber(trimmed);
  if (value === null) {
    await slackClient.chat.postMessage({
      channel: conversation.channelId,
      text: 'Please send a valid number (e.g., 12 or 7.5).',
    });
    return;
  }

  await onSuccess(value);
}

function extractNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const normalised = value.trim().replace(',', '.');
  if (normalised === '') {
    return null;
  }
  const parsed = Number.parseFloat(normalised);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

async function cancelConversation(conversation) {
  await slackClient.chat.postMessage({
    channel: conversation.channelId,
    text: 'Conversation cancelled. Start again with /capacity-ping when ready.',
  });
  await deleteConversationState(conversation.channelId);
}

async function handleConversationText(conversation, rawText = '') {
  if (!conversation || !rawText) {
    return;
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    await slackClient.chat.postMessage({
      channel: conversation.channelId,
      text: 'Please reply with some text or type *cancel*.',
    });
    return;
  }

  if (trimmed.toLowerCase() === 'cancel') {
    await cancelConversation(conversation);
    return;
  }

  switch (conversation.state) {
    case 'awaiting_mandatory_selection': {
      const lower = trimmed.toLowerCase();
      if (['none', 'skip'].includes(lower)) {
        conversation.mandatorySelections = [];
        conversation.mandatoryValues = {};
        conversation.currentMandatoryIndex = 0;
        await saveConversation(conversation);
        await promptDeveloperQuestion(conversation);
        return;
      }
      if (['done', 'finish', 'next'].includes(lower)) {
        conversation.mandatoryValues = {};
        conversation.currentMandatoryIndex = 0;
        await saveConversation(conversation);
        if (conversation.mandatorySelections.length) {
          await promptNextMandatoryHours(conversation);
        } else {
          await promptDeveloperQuestion(conversation);
        }
        return;
      }
      if (lower === 'clear') {
        conversation.mandatorySelections = [];
        conversation.mandatoryValues = {};
        conversation.currentMandatoryIndex = 0;
        await saveConversation(conversation);
        await slackClient.chat.postMessage({
          channel: conversation.channelId,
          text: 'Cleared the selected business areas.',
        });
        await promptMandatorySelection(conversation);
        return;
      }
      await slackClient.chat.postMessage({
        channel: conversation.channelId,
        text:
          'Use the dropdown to add areas one by one, or type *done* when you are finished, *none* to skip, or *clear* to reset.',
      });
      break;
    }
    case 'awaiting_contract_hours':
      await handleNumericAnswer({
        conversation,
        text: trimmed,
        onSuccess: async (value) => {
          conversation.contractHours = value;
          await saveConversation(conversation);
          await promptMandatorySelection(conversation);
        },
      });
      break;
    case 'awaiting_mandatory_hours': {
      const fieldId =
        conversation.mandatorySelections[conversation.currentMandatoryIndex];
      if (!fieldId) {
        await promptDeveloperQuestion(conversation);
        return;
      }
      await handleNumericAnswer({
        conversation,
        text: trimmed,
        onSuccess: async (value) => {
          conversation.mandatoryValues[fieldId] = value;
          conversation.currentMandatoryIndex += 1;
          await saveConversation(conversation);
          await promptNextMandatoryHours(conversation);
        },
      });
      break;
    }
    case 'awaiting_developer_hours': {
      const field = DEVELOPER_FIELDS[conversation.currentDeveloperIndex];
      if (!field) {
        await promptProjectSelection(conversation);
        return;
      }

      await handleNumericAnswer({
        conversation,
        text: trimmed,
        allowSkip: true,
        onSuccess: async (value) => {
          conversation.developerValues[field.id] = value;
          conversation.currentDeveloperIndex += 1;
          await saveConversation(conversation);
          await promptNextDeveloperHours(conversation);
        },
      });
      break;
    }
    case 'awaiting_project_hours': {
      const currentProject =
        conversation.projectsSelected[conversation.currentProjectIndex];
      if (!currentProject) {
        await finalizeConversation(conversation);
        return;
      }

      await handleNumericAnswer({
        conversation,
        text: trimmed,
        onSuccess: async (value) => {
          conversation.projectHours[currentProject.id] = value;
          conversation.currentProjectIndex += 1;
          await saveConversation(conversation);
          await promptNextProjectHours(conversation);
        },
      });
      break;
    }
    case 'awaiting_project_selection': {
      const lower = trimmed.toLowerCase();
      if (['none', 'skip'].includes(lower)) {
        conversation.projectsSelected = [];
        conversation.projectHours = {};
        conversation.currentProjectIndex = 0;
        await saveConversation(conversation);
        await finalizeConversation(conversation);
        return;
      }
      if (['done', 'finish', 'next'].includes(lower)) {
        conversation.projectHours = {};
        conversation.currentProjectIndex = 0;
        await saveConversation(conversation);
        if (conversation.projectsSelected.length) {
          await promptNextProjectHours(conversation);
        } else {
          await finalizeConversation(conversation);
        }
        return;
      }
      if (lower === 'clear') {
        conversation.projectsSelected = [];
        conversation.projectHours = {};
        conversation.currentProjectIndex = 0;
        await saveConversation(conversation);
        await slackClient.chat.postMessage({
          channel: conversation.channelId,
          text: 'Cleared selected projects.',
        });
        await promptProjectSelection(conversation);
        return;
      }
      await slackClient.chat.postMessage({
        channel: conversation.channelId,
        text:
          'Use the dropdown to add projects, or type *done* when finished, *none* if there were no projects, or *clear* to reset.',
      });
      break;
    }
    default:
      await slackClient.chat.postMessage({
        channel: conversation.channelId,
        text: 'Please use the buttons above to continue.',
      });
  }
}

async function archiveAdditionalEntries(personId, weekName) {
  assertNotionConfig();

  let cursor;
  do {
    const response = await notionClient.databases.query({
      database_id: notionCapacityDbId,
      start_cursor: cursor,
      filter: {
        and: [
          { property: 'Person', people: { contains: personId } },
          { property: 'Name', title: { starts_with: `${weekName} (` } },
        ],
      },
    });

    for (const page of response.results || []) {
      await notionClient.pages.update({
        page_id: page.id,
        archived: true,
      });
    }

    cursor = response.next_cursor;
  } while (cursor);
}

async function createAdditionalProjectEntry({
  personId,
  weekInfo,
  project,
  hours,
  index,
}) {
  assertNotionConfig();

  const response = await notionClient.pages.create({
    parent: { database_id: notionCapacityDbId },
    properties: {
      Name: {
        title: [
          {
            type: 'text',
            text: { content: `${weekInfo.weekName} (${index})` },
          },
        ],
      },
      Person: {
        people: [{ id: personId }],
      },
      Woche: {
        date: {
          start: weekInfo.start,
          end: weekInfo.end,
        },
      },
      Projekt: {
        relation: [{ id: project.id }],
      },
      'Stunden Projekt': {
        number: hours,
      },
    },
  });

  return response;
}

async function saveCapacityToNotion(metadata) {
  assertNotionConfig();

  const {
    pageId,
    personId,
    contractHours,
    mandatoryValues = {},
    developerValues = {},
    weekInfo,
    projects = [],
    projectHours = {},
  } = metadata;

  let targetPageId = pageId;
  if (!targetPageId) {
    const basePage = await ensureBaseEntry({ personId, weekInfo });
    targetPageId = basePage.id;
  }

  const properties = {
    Name: {
      title: [
        {
          type: 'text',
          text: { content: weekInfo.weekName },
        },
      ],
    },
    Person: {
      people: [{ id: personId }],
    },
    Woche: {
      date: {
        start: weekInfo.start,
        end: weekInfo.end,
      },
    },
    Verfügbar: {
      number: contractHours,
    },
  };

  for (const [field, value] of Object.entries(mandatoryValues)) {
    properties[field] = { number: value };
  }

  for (const [field, value] of Object.entries(developerValues)) {
    properties[field] = { number: value };
  }

  if (!projects.length) {
    properties.Projekt = { relation: [] };
    properties['Stunden Projekt'] = { number: null };
  } else {
    const first = projects[0];
    properties.Projekt = { relation: [{ id: first.id }] };
    properties['Stunden Projekt'] = {
      number: projectHours[first.id] ?? null,
    };
  }

  await notionClient.pages.update({
    page_id: targetPageId,
    properties,
  });

  await archiveAdditionalEntries(personId, weekInfo.weekName);

  const additional = projects.slice(1);
  let counter = 1;
  for (const project of additional) {
    const hours = projectHours[project.id] ?? null;
    await createAdditionalProjectEntry({
      personId,
      weekInfo,
      project,
      hours,
      index: counter,
    });
    counter += 1;
  }
}

if (app) {
  app.action(PROMPT_BUTTON_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      await startCapacityConversation({
        userId: body.user?.id,
        channelId: body.channel?.id,
      });
    } catch (error) {
      logger?.error?.(error);
    }
  });

  app.command('/capacity-ping', async ({ ack, body, respond, logger }) => {
    await ack();
    try {
      const trimmed = body.text?.trim();
      if (trimmed === 'broadcast') {
        await sendCapacityPrompts();
        await respond('Sent the capacity reminders.');
      } else {
        await startCapacityConversation({
          userId: body.user_id,
          channelId: null,
        });
        await respond('Check your DM to answer the questions.');
      }
    } catch (error) {
      logger?.error?.(error);
      await respond('Action failed. Please check the Lambda logs.');
    }
  });

  app.action(
    ACTION_IDS.PERSON,
    async ({ ack, body, action, logger }) => {
      await ack();
      try {
        const channelId = body.channel?.id;
        const conversation = await loadConversation(channelId);
        if (!conversation || conversation.userId !== body.user?.id) {
          await notifyStaleConversation(body.user?.id, channelId);
          return;
        }

        const selected = action?.selected_option?.value;
        if (!selected) {
          await slackClient.chat.postMessage({
            channel: conversation.channelId,
            text: 'Please choose a person to continue.',
          });
          return;
        }

        conversation.personId = selected;
        await saveConversation(conversation);
        await promptContractHours(conversation);
      } catch (error) {
        logger?.error?.(error);
      }
    }
  );

  app.action(
    ACTION_IDS.MANDATORY,
    async ({ ack, body, action, logger }) => {
      await ack();
      try {
        const channelId = body.channel?.id;
        const conversation = await loadConversation(channelId);
        if (!conversation || conversation.userId !== body.user?.id) {
          await notifyStaleConversation(body.user?.id, channelId);
          return;
        }

        const value = action?.selected_option?.value;
        if (!value) {
          await promptMandatorySelection(conversation);
          return;
        }

        if (value === SELECT_SPECIAL_VALUES.CLEAR) {
          conversation.mandatorySelections = [];
          conversation.mandatoryValues = {};
          conversation.currentMandatoryIndex = 0;
          await saveConversation(conversation);
          await slackClient.chat.postMessage({
            channel: conversation.channelId,
            text: 'Cleared the selected business areas.',
          });
          await promptMandatorySelection(conversation);
          return;
        }

        if (value === SELECT_SPECIAL_VALUES.DONE) {
          conversation.mandatoryValues = {};
          conversation.currentMandatoryIndex = 0;
          await saveConversation(conversation);
          if (conversation.mandatorySelections.length) {
            await promptNextMandatoryHours(conversation);
          } else {
            await promptDeveloperQuestion(conversation);
          }
          return;
        }

        if (conversation.mandatorySelections.includes(value)) {
          await slackClient.chat.postMessage({
            channel: conversation.channelId,
            text: 'That area is already selected. Choose another or select Done.',
          });
          await promptMandatorySelection(conversation);
          return;
        }

        conversation.mandatorySelections.push(value);
        await saveConversation(conversation);
        await slackClient.chat.postMessage({
          channel: conversation.channelId,
          text: `Added *${getFieldLabel(mandatoryFieldLabels, value)}*. Select more or choose *Done selecting*.`,
        });
        await promptMandatorySelection(conversation);
      } catch (error) {
        logger?.error?.(error);
      }
    }
  );

  app.action(
    ACTION_IDS.DEVELOPER,
    async ({ ack, body, action, logger }) => {
      await ack();
      try {
        const channelId = body.channel?.id;
        const conversation = await loadConversation(channelId);
        if (!conversation || conversation.userId !== body.user?.id) {
          await notifyStaleConversation(body.user?.id, channelId);
          return;
        }

        const selectedValue = action?.selected_option?.value;
        conversation.isDeveloper = selectedValue === 'yes';
        conversation.developerValues = {};
        conversation.currentDeveloperIndex = 0;
        await saveConversation(conversation);

        if (conversation.isDeveloper) {
          await promptNextDeveloperHours(conversation);
        } else {
          await promptProjectSelection(conversation);
        }
      } catch (error) {
        logger?.error?.(error);
      }
    }
  );

  app.action(
    ACTION_IDS.PROJECTS,
    async ({ ack, body, action, logger }) => {
      await ack();
      try {
        const channelId = body.channel?.id;
        const conversation = await loadConversation(channelId);
        if (!conversation || conversation.userId !== body.user?.id) {
          await notifyStaleConversation(body.user?.id, channelId);
          return;
        }

        const value = action?.selected_option?.value;
        if (!value) {
          await promptProjectSelection(conversation);
          return;
        }

        if (value === SELECT_SPECIAL_VALUES.CLEAR) {
          conversation.projectsSelected = [];
          conversation.projectHours = {};
          conversation.currentProjectIndex = 0;
          await saveConversation(conversation);
          await slackClient.chat.postMessage({
            channel: conversation.channelId,
            text: 'Cleared selected projects.',
          });
          await promptProjectSelection(conversation);
          return;
        }

        if (value === SELECT_SPECIAL_VALUES.DONE) {
          conversation.projectHours = {};
          conversation.currentProjectIndex = 0;
          await saveConversation(conversation);
          if (conversation.projectsSelected.length) {
            await promptNextProjectHours(conversation);
          } else {
            await finalizeConversation(conversation);
          }
          return;
        }

        if (conversation.projectsSelected.find((project) => project.id === value)) {
          await slackClient.chat.postMessage({
            channel: conversation.channelId,
            text: 'That project is already selected. Choose another or select Done.',
          });
          await promptProjectSelection(conversation);
          return;
        }

        const projectLookup = new Map(
          (conversation.projects || []).map((project) => [project.id, project])
        );
        const project =
          projectLookup.get(value) || {
            id: value,
            name: action?.selected_option?.text?.text || 'Projekt',
          };

        conversation.projectsSelected.push(project);
        await saveConversation(conversation);
        await slackClient.chat.postMessage({
          channel: conversation.channelId,
          text: `Added project *${project.name}*. Select more or choose *Done selecting projects*.`,
        });
        await promptProjectSelection(conversation);
      } catch (error) {
        logger?.error?.(error);
      }
    }
  );

  app.message(async ({ message, logger }) => {
    try {
      if (
        !message ||
        message.subtype ||
        !message.channel ||
        !message.user ||
        message.bot_id
      ) {
        return;
      }

      const conversation = await loadConversation(message.channel);
      if (!conversation || conversation.userId !== message.user) {
        return;
      }

      await handleConversationText(conversation, message.text || '');
    } catch (error) {
      logger?.error?.(error);
    }
  });
}

const slackHandlerPromise = awsLambdaReceiver ? awsLambdaReceiver.start() : null;

function isScheduledEvent(event = {}) {
  return (
    event.source === 'aws.events' ||
    event['detail-type'] === 'Scheduled Event' ||
    event.trigger === 'capacity-cron'
  );
}

async function handler(event, context, callback) {
  if (isScheduledEvent(event)) {
    await sendCapacityPrompts();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  }

  if (!slackHandlerPromise) {
    throw new Error('Slack handler not configured.');
  }

  const slackHandler = await slackHandlerPromise;
  if (typeof slackHandler !== 'function') {
    throw new Error('Slack handler failed to initialize.');
  }

  return slackHandler(event, context, callback);
}

module.exports = {
  handler,
};
