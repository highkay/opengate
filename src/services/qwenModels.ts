import modelsConfig from '../models.json' with { type: 'json' };
import { getAllAccountEmails, getTokenWithAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { DEFAULT_SYSTEM_PROMPT } from './defaultSystemPrompt.ts';
import { logStore } from './logStore.ts';
import { COMPAT_MODEL_ALIASES } from './modelRouter.ts';
import { completeEntry, errorEntry } from './networkDebug.ts';
import { QWEN_API_BASE, QWEN_CHATS_URL, QWEN_SETTINGS_URL } from './qwen.ts';

export { DEFAULT_SYSTEM_PROMPT };

async function postQwenSettings(
  email: string | undefined,
  payload: Record<string, unknown>,
): Promise<{ response: Response; debugId: string }> {
  const bodyStr = JSON.stringify(payload);
  const tokenInfo = email ? await getTokenWithAccount(email) : null;
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
  const response = await browserlessFetch(QWEN_SETTINGS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      source: 'web',
      cookie: cookieStr,
      origin: QWEN_API_BASE,
      referer: 'https://chat.qwen.ai/',
    },
    body: bodyStr,
    accountEmail: email,
  });
  return { response, debugId: 'browserless-' + Date.now() };
}

let customInstructionApplied = false;
let applyingCustomInstructionInProgress: Promise<void> | null = null;

interface LocalModelConfig {
  max_context: number;
  max_output: number;
  modalities: string[];
}

function normalizeCatalogModelId(modelId: string): string {
  return modelId.replace(/^qwen([23])-(\d)-/, 'qwen$1.$2-');
}

function buildLocalModelCatalog(): any[] {
  const created = Math.floor(Date.now() / 1000);
  const models = new Map<string, any>();
  for (const [configuredId, rawConfig] of Object.entries(modelsConfig)) {
    const modelConfig = rawConfig as LocalModelConfig;
    const id = normalizeCatalogModelId(configuredId);
    models.set(id, {
      id,
      object: 'model',
      created,
      owned_by: 'qwen',
      context_window: modelConfig.max_context,
      max_output_tokens: modelConfig.max_output,
      modalities: modelConfig.modalities,
      description: '',
      capabilities: {},
    });
  }
  for (const [alias, target] of Object.entries(COMPAT_MODEL_ALIASES)) {
    const base = models.get(target) || {
      object: 'model',
      created,
      owned_by: 'qwen',
      context_window: 250000,
      max_output_tokens: 65000,
      modalities: ['text'],
      description: '',
      capabilities: {},
    };
    models.set(alias, { ...base, id: alias, owned_by: 'qwen2api-compat', base_model: target });
  }
  return [...models.values()];
}

const localModelCatalog = buildLocalModelCatalog();

export async function setCustomInstruction(instruction: string): Promise<void> {
  if (!instruction || instruction.trim().length === 0) return;
  if (customInstructionApplied) return;
  if (applyingCustomInstructionInProgress) {
    await applyingCustomInstructionInProgress;
    return;
  }
  applyingCustomInstructionInProgress = (async () => {
    const emails = getAllAccountEmails();
    const accountsToProcess = emails.length > 0 ? emails : ['primary'];
    let successCount = 0;
    for (const email of accountsToProcess) {
      let settingsDebugId: string | null = null;
      try {
        const payload = {
          personalization: {
            instruction: instruction,
            enable_for_new_chat: true,
          },
        };
        const { response, debugId } = await postQwenSettings(email, payload);
        settingsDebugId = debugId;
        if (!response.ok) {
          const text = await response.text();
          console.error(`[Qwen] Failed to set custom instruction for ${email}: ${response.status} - ${text}`);
        } else {
          successCount++;
        }
        completeEntry(settingsDebugId);
      } catch (err: any) {
        if (settingsDebugId) errorEntry(settingsDebugId, err.message);
        console.error(`[Qwen] Error setting custom instruction for ${email}: ${err.message}`);
      }
    }
    customInstructionApplied = successCount > 0;
    if (!customInstructionApplied) {
      console.error('[Qwen] Custom instruction failed for all accounts — will retry on next call');
    }
  })();
  try {
    return await applyingCustomInstructionInProgress;
  } finally {
    applyingCustomInstructionInProgress = null;
  }
}

export async function configureAccount(email: string, instruction?: string): Promise<void> {
  let settingsDebugId: string | null = null;
  try {
    const payload: Record<string, any> = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false,
        image_search: false,
      },
      memory: { enable_memory: false, enable_history_memory: false },
      mcp: { 'code-interpreter': false, 'fire-crawl': false, amap: false, 'image-generation': false },
    };
    if (instruction && instruction.trim().length > 0) {
      payload.personalization = { instruction, enable_for_new_chat: true };
    } else if (!instruction) {
      const useCustom = config.get('USE_CUSTOM_INSTRUCTION') === 'true';
      const resolved = useCustom ? config.get('CUSTOM_INSTRUCTION') : DEFAULT_SYSTEM_PROMPT;
      if (resolved && resolved.trim().length > 0) {
        payload.personalization = { instruction: resolved, enable_for_new_chat: true };
      }
    }
    const { response, debugId } = await postQwenSettings(email, payload);
    settingsDebugId = debugId;
    if (response.ok) {
      logStore.log('info', 'account', `Account ${email} configured (tools off, memory off${instruction ? ', instruction set' : ''})`);
    } else {
      const text = await response.text();
      console.error(`[Qwen] Failed to configure ${email}: ${response.status} - ${text}`);
    }
    completeEntry(settingsDebugId);
  } catch (err: any) {
    if (settingsDebugId) errorEntry(settingsDebugId, err.message);
    console.error(`[Qwen] Error configuring ${email}: ${err.message}`);
  }
}

export async function deleteAllChats(email: string): Promise<void> {
  try {
    const tokenInfo = email ? await getTokenWithAccount(email) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
    const response = await browserlessFetch(QWEN_CHATS_URL, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
        referer: 'https://chat.qwen.ai/',
      },
      accountEmail: email,
    });
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body?.success !== false) {
        logStore.log('info', 'account', `All chats deleted for ${email}`);
      } else {
        throw new Error(`Delete chats failed: ${body?.message || body?.error || JSON.stringify(body)}`);
      }
    } else {
      const errText = await response.text().catch(() => '');
      throw new Error(`Delete chats failed for ${email}: ${response.status} - ${errText}`);
    }
    return;
  } catch (err: any) {
    console.error(`[Qwen] Error deleting chats for ${email}: ${err.message}`);
    throw err;
  }
}

export async function fetchQwenModels(): Promise<any[]> {
  return localModelCatalog;
}
