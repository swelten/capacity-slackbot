const { App, AwsLambdaReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { Client: NotionClient } = require('@notionhq/client');
const { DateTime } = require('luxon');

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;

const notionToken = process.env.NOTION_API_TOKEN;
const notionCapacityDbId = process.env.NOTION_CAPACITY_DB_ID;
const notionProjectsDbId = process.env.NOTION_PROJECTS_DB_ID;
const timezone = process.env.CAPACITY_TIMEZONE || 'Europe/Berlin';

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

const configuredTargets = (process.env.CAPACITY_TARGETS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const PROMPT_BUTTON_ACTION = 'open_capacity_modal';
const PROMPT_TEXT =
  'Bitte trage deine Kapazitäten für die aktuelle Kalenderwoche ein. Klicke auf den Button, um das Formular zu öffnen.';

const STEP_ONE_ID = 'capacity_step_1';
const STEP_TWO_ID = 'capacity_step_2';
const STEP_THREE_ID = 'capacity_step_3';

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

  const monday = base.minus({ days: base.weekday - 1 }).startOf('day');
  const sunday = monday.plus({ days: 6 }).endOf('day');
  const weekNumber = base.weekNumber;

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
              text: `Zeitraum: ${weekInfo.start} bis ${weekInfo.end}`,
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Kapazität melden' },
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

function buildBlockId(prefix, name) {
  return `${prefix}_${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
}

function serialiseMetadata(metadata) {
  return JSON.stringify(metadata);
}

function parseMetadata(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function buildLoadingView() {
  return {
    type: 'modal',
    callback_id: 'loading_view',
    title: {
      type: 'plain_text',
      text: 'Kapazität',
    },
    close: {
      type: 'plain_text',
      text: 'Schließen',
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Lade Notion-Daten … bitte warten.',
        },
      },
    ],
  };
}

function buildErrorView(message) {
  return {
    type: 'modal',
    callback_id: 'error_view',
    title: {
      type: 'plain_text',
      text: 'Kapazität',
    },
    close: {
      type: 'plain_text',
      text: 'Schließen',
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *Fehler*\n${message}`,
        },
      },
    ],
  };
}

function buildStepOneView({ people, projects, weekInfo }) {
  const peopleOptions = people.map((person) => ({
    text: {
      type: 'plain_text',
      text: person.name,
    },
    value: person.id,
  }));

  const projectOptions = projects.map((project) => ({
    text: {
      type: 'plain_text',
      text: project.name.slice(0, 75),
    },
    value: project.id,
  }));

  return {
    type: 'modal',
    callback_id: STEP_ONE_ID,
    private_metadata: serialiseMetadata({}),
    title: {
      type: 'plain_text',
      text: 'Kapazität eintragen',
    },
    submit: {
      type: 'plain_text',
      text: 'Weiter',
    },
    close: {
      type: 'plain_text',
      text: 'Abbrechen',
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Kalenderwoche *${weekInfo.weekName}* (${weekInfo.start} – ${weekInfo.end})`,
        },
      },
      {
        type: 'input',
        block_id: 'person_block',
        label: {
          type: 'plain_text',
          text: 'Person auswählen',
        },
        element: {
          type: 'static_select',
          action_id: 'person_select',
          placeholder: {
            type: 'plain_text',
            text: 'Wer füllt die Kapazität aus?',
          },
          options: peopleOptions,
        },
      },
      {
        type: 'input',
        block_id: 'contract_block',
        label: {
          type: 'plain_text',
          text: 'KW Arbeitsstunden',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'contract_input',
          placeholder: {
            type: 'plain_text',
            text: 'Nur Zahl eingeben',
          },
        },
        hint: {
          type: 'plain_text',
          text: 'Wie viele Stunden hast du gearbeitet? Komplette Woche = z. B. 40, sonst weniger.',
        },
      },
      {
        type: 'input',
        block_id: 'mandatory_block',
        label: {
          type: 'plain_text',
          text: 'Pflicht-Bereiche auswählen',
        },
        element: {
          type: 'multi_static_select',
          action_id: 'mandatory_select',
          placeholder: {
            type: 'plain_text',
            text: 'Wähle die Bereiche, in denen du gearbeitet hast',
          },
          options: MANDATORY_FIELDS.map((field) => ({
            text: { type: 'plain_text', text: field.label },
            value: field.id,
          })),
        },
      },
      {
        type: 'input',
        optional: false,
        block_id: 'developer_block',
        label: {
          type: 'plain_text',
          text: 'Bist du Entwickler:in?',
        },
        element: {
          type: 'static_select',
          action_id: 'developer_choice',
          options: [
            { text: { type: 'plain_text', text: 'Ja' }, value: 'yes' },
            { text: { type: 'plain_text', text: 'Nein' }, value: 'no' },
          ],
        },
      },
      {
        type: 'input',
        optional: true,
        block_id: 'projects_block',
        label: {
          type: 'plain_text',
          text: 'Projekte (Multi-Select)',
        },
        element: {
          type: 'multi_static_select',
          action_id: 'projects_select',
          placeholder: {
            type: 'plain_text',
            text: 'Wähle alle Projekte dieser Woche',
          },
          options: projectOptions,
        },
      },
    ],
  };
}

function buildStepTwoView(metadata) {
  const blocks = [];

  if (metadata.mandatorySelections?.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Bitte gib die Stunden für die ausgewählten Bereiche ein.',
      },
    });

    for (const field of metadata.mandatorySelections) {
      const blockId = buildBlockId('mandatory', field);

      blocks.push({
        type: 'input',
        block_id: blockId,
        label: {
          type: 'plain_text',
          text: `${field} Stunden`,
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: {
            type: 'plain_text',
            text: 'Nur Zahl eingeben',
          },
        },
      });
    }
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Keine allgemeinen Bereiche ausgewählt.',
      },
    });
  }

  if (metadata.isDeveloper) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Developer Bereiche*',
      },
    });

    for (const field of DEVELOPER_FIELDS) {
      const blockId = buildBlockId('developer', field.id);

      blocks.push({
        type: 'input',
        block_id: blockId,
        optional: true,
        label: {
          type: 'plain_text',
          text: `${field.label} Stunden`,
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: {
            type: 'plain_text',
            text: 'Nur Zahl eingeben',
          },
        },
      });
    }
  }

  return {
    type: 'modal',
    callback_id: STEP_TWO_ID,
    private_metadata: serialiseMetadata(metadata),
    title: {
      type: 'plain_text',
      text: 'Aufgaben',
    },
    submit: {
      type: 'plain_text',
      text: metadata.projects?.length ? 'Weiter' : 'Speichern',
    },
    close: {
      type: 'plain_text',
      text: 'Zurück',
    },
    blocks,
  };
}

function buildStepThreeView(metadata) {
  const blocks = [];

  if (!metadata.projects?.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Keine Projekte ausgewählt.',
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Bitte gib die Projektstunden an.',
      },
    });

    metadata.projects.forEach((project, index) => {
      const blockId = buildBlockId('project', `${index}_${project.id}`);
      blocks.push({
        type: 'input',
        block_id: blockId,
        label: {
          type: 'plain_text',
          text: `${project.name} (Stunden)`,
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: {
            type: 'plain_text',
            text: 'Nur Zahl eingeben',
          },
        },
      });
    });
  }

  return {
    type: 'modal',
    callback_id: STEP_THREE_ID,
    private_metadata: serialiseMetadata(metadata),
    title: {
      type: 'plain_text',
      text: 'Projektarbeit',
    },
    submit: {
      type: 'plain_text',
      text: 'Fertigstellen',
    },
    close: {
      type: 'plain_text',
      text: 'Zurück',
    },
    blocks,
  };
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

function getInputValue(values, blockId, actionId = 'value') {
  const block = values[blockId];
  if (!block) {
    return '';
  }

  const action = block[actionId];
  if (action && typeof action.value === 'string') {
    return action.value;
  }

  const first = Object.values(block)[0];
  if (first && typeof first.value === 'string') {
    return first.value;
  }

  return '';
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

async function notifyUser(userId, text) {
  assertSlackClient();
  const dm = await slackClient.conversations.open({ users: userId });
  if (!dm?.channel?.id) {
    return;
  }

  await slackClient.chat.postMessage({
    channel: dm.channel.id,
    text,
  });
}

async function openCapacityModal(triggerId) {
  assertSlackClient();
  assertNotionConfig();

  const loadingView = buildLoadingView();
  const openResponse = await slackClient.views.open({
    trigger_id: triggerId,
    view: loadingView,
  });

  const viewId = openResponse?.view?.id;

  try {
    const [people, projects] = await Promise.all([
      fetchNotionPeople(),
      fetchProjects(),
    ]);

    if (!people.length) {
      throw new Error(
        'Keine Notion Nutzer gefunden. Teile die Datenbank mit der Integration.'
      );
    }

    const weekInfo = getWeekBounds();
    const stepOneView = buildStepOneView({ people, projects, weekInfo });

    await slackClient.views.update({
      view_id: viewId,
      view: stepOneView,
    });
  } catch (error) {
    if (viewId) {
      await slackClient.views.update({
        view_id: viewId,
        view: buildErrorView(
          'Formular konnte nicht geladen werden. Bitte erneut versuchen.'
        ),
      });
    }
    throw error;
  }
}

function extractSelectedProjects(selected = []) {
  return selected.map((option) => ({
    id: option.value,
    name: option.text?.text || 'Projekt',
  }));
}

if (app) {
  app.action(PROMPT_BUTTON_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      await openCapacityModal(body.trigger_id);
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
        await respond('Kapazitätsanfragen wurden gesendet.');
      } else {
        await openCapacityModal(body.trigger_id);
        await respond(
          'Ein Formular zur Erfassung deiner Kapazität wurde geöffnet.'
        );
      }
    } catch (error) {
      logger?.error?.(error);
      await respond('Aktion fehlgeschlagen. Bitte Logs prüfen.');
    }
  });

  app.view(STEP_ONE_ID, async ({ ack, body, view, logger }) => {
    try {
      const values = view.state.values;
      const person =
        values.person_block.person_select.selected_option?.value || null;
      const contractRaw = values.contract_block.contract_input.value;
      const contractHours = extractNumber(contractRaw);
      const mandatorySelections =
        values.mandatory_block.mandatory_select.selected_options?.map(
          (opt) => opt.value
        ) || [];
      const developerChoice =
        values.developer_block.developer_choice.selected_option?.value ===
        'yes';
      const projects = extractSelectedProjects(
        values.projects_block.projects_select.selected_options || []
      );

      const errors = {};
      if (!person) {
        errors.person_block = 'Bitte Person wählen.';
      }
      if (contractHours === null) {
        errors.contract_block = 'Bitte Zahl eingeben.';
      }

      if (Object.keys(errors).length) {
        await ack({
          response_action: 'errors',
          errors,
        });
        return;
      }

      const weekInfo = getWeekBounds();
      const metadata = {
        userId: body.user.id,
        pageId: null,
        personId: person,
        contractHours,
        weekInfo,
        mandatorySelections,
        isDeveloper: developerChoice,
        projects,
      };

      const needsTaskInputs =
        (metadata.mandatorySelections?.length || 0) > 0 || metadata.isDeveloper;

      if (needsTaskInputs) {
        await ack({
          response_action: 'push',
          view: buildStepTwoView(metadata),
        });
        return;
      }

      if (metadata.projects?.length) {
        metadata.mandatoryValues = {};
        metadata.developerValues = {};
        await ack({
          response_action: 'push',
          view: buildStepThreeView(metadata),
        });
        return;
      }

      metadata.mandatoryValues = {};
      metadata.developerValues = {};
      try {
        await saveCapacityToNotion(metadata);
        await ack({ response_action: 'clear' });
        await notifyUser(metadata.userId, 'Kapazität gespeichert. Danke!');
      } catch (error) {
        logger?.error?.(error);
        await ack({
          response_action: 'errors',
          errors: {
            mandatory_block:
              'Speichern fehlgeschlagen. Bitte später erneut versuchen.',
          },
        });
      }
    } catch (error) {
      logger?.error?.(error);
      await ack({
        response_action: 'errors',
        errors: {
          contract_block: 'Ein Fehler ist aufgetreten. Bitte erneut versuchen.',
        },
      });
    }
  });

  app.view(STEP_TWO_ID, async ({ ack, body, view, logger }) => {
    const metadata = parseMetadata(view.private_metadata);
    const values = view.state.values;
    const errors = {};

    const mandatoryValues = {};
    for (const field of metadata.mandatorySelections || []) {
      const blockId = buildBlockId('mandatory', field);
      const raw = getInputValue(values, blockId);
      const extracted = extractNumber(raw);
      if (extracted === null) {
        errors[blockId] = 'Zahl erforderlich.';
      } else {
        mandatoryValues[field] = extracted;
      }
    }

    const developerValues = {};
    if (metadata.isDeveloper) {
      for (const field of DEVELOPER_FIELDS) {
        const blockId = buildBlockId('developer', field.id);
        const raw = getInputValue(values, blockId);
        const extracted = extractNumber(raw);
        developerValues[field.id] = extracted;
      }
    }

    if (Object.keys(errors).length) {
      await ack({
        response_action: 'errors',
        errors,
      });
      return;
    }

    metadata.mandatoryValues = mandatoryValues;
    metadata.developerValues = developerValues;

    if (metadata.projects?.length) {
      await ack({
        response_action: 'push',
        view: buildStepThreeView(metadata),
      });
      return;
    }

    try {
      await saveCapacityToNotion(metadata);
      await ack({ response_action: 'clear' });
      await notifyUser(metadata.userId, 'Kapazität gespeichert. Danke!');
    } catch (error) {
      logger?.error?.(error);
      await ack({
        response_action: 'errors',
        errors: {
          mandatory_block:
            'Speichern fehlgeschlagen. Bitte später erneut versuchen.',
        },
      });
    }
  });

  app.view(STEP_THREE_ID, async ({ ack, body, view, logger }) => {
    const metadata = parseMetadata(view.private_metadata);
    const values = view.state.values;
    const errors = {};
    const projectHours = {};

    metadata.projects?.forEach((project, index) => {
      const blockId = buildBlockId('project', `${index}_${project.id}`);
      const raw = getInputValue(values, blockId);
      const extracted = extractNumber(raw);
      if (extracted === null) {
        errors[blockId] = 'Zahl erforderlich.';
      } else {
        projectHours[project.id] = extracted;
      }
    });

    if (Object.keys(errors).length) {
      await ack({
        response_action: 'errors',
        errors,
      });
      return;
    }

    metadata.projectHours = projectHours;

    try {
      await saveCapacityToNotion(metadata);
      await ack({ response_action: 'clear' });
      await notifyUser(metadata.userId, 'Kapazität & Projekte gespeichert.');
    } catch (error) {
      logger?.error?.(error);
      await ack({
        response_action: 'errors',
        errors: {
          projects_block:
            'Speichern fehlgeschlagen. Bitte später erneut versuchen.',
        },
      });
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
