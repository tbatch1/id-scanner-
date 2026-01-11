// Chat Service - OpenAI API integration with tool use for business intelligence
const logger = require('./logger');
const { toolDefinitions, executeTool } = require('./chatTools');

let OpenAI = null;
try {
  OpenAI = require('openai');
} catch (error) {
  logger.warn(
    {
      event: 'chat_sdk_missing',
      dependency: 'openai',
      error: error?.message
    },
    'Chat dependencies missing; AI assistant endpoints will be disabled until installed'
  );
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';
const OPENAI_FALLBACK_MODELS = String(process.env.OPENAI_FALLBACK_MODELS || 'gpt-4.1-nano,gpt-4o-mini')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const OPENAI_MAX_OUTPUT_TOKENS = Math.max(
  256,
  Math.min(4096, Number.parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || '1024', 10) || 1024)
);

const SYSTEM_PROMPT = `You are a helpful business intelligence assistant for a retail store using Lightspeed POS. You help managers understand their sales, inventory, customers, and store performance.

You have access to tools that query the store's data. When a user asks a business question, use the appropriate tool(s) to get data, then provide a clear, concise answer.

Guidelines:
- Be concise and direct. Managers are busy.
- Format numbers nicely (e.g., $1,234.56 for currency, 1,234 for quantities).
- When comparing data, highlight the key insights.
- If data is unavailable or there's an error, explain briefly and suggest alternatives.
- For inventory questions, mention items that need attention (low stock, below reorder point).
- For sales questions, highlight top performers and trends.
- For customer questions, focus on value and loyalty.

The store sells cannabis products and requires ID verification for compliance. You can also answer questions about verification statistics.

Current date: ${new Date().toLocaleDateString()}`;

function toOpenAITools(tools) {
  return (tools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }));
}

function toResponsesTools(tools) {
  return (tools || []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || { type: 'object', properties: {} },
    strict: true
  }));
}

function normalizeHistory(conversationHistory) {
  if (!Array.isArray(conversationHistory)) return [];

  const allowedRoles = new Set(['system', 'user', 'assistant', 'developer', 'tool']);
  return conversationHistory
    .filter((m) => m && allowedRoles.has(m.role))
    .map((m) => {
      if (m.role === 'tool') return m;
      return {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      };
    });
}

function isModelUnavailableError(error) {
  const status = error?.status || error?.response?.status || null;
  const message = String(error?.message || '').toLowerCase();
  return (
    status === 404 ||
    (status === 400 && message.includes('model') && (message.includes('not found') || message.includes('does not exist') || message.includes('unavailable')))
  );
}

class ChatService {
  constructor() {
    this.client = (OpenAI && OPENAI_API_KEY) ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  async chat(userMessage, conversationHistory = []) {
    if (!OpenAI) {
      return {
        success: false,
        error: 'DEPENDENCY_MISSING',
        message: 'AI assistant dependencies are missing on the server. Install the openai package to enable chat.'
      };
    }

    if (!this.client) {
      return {
        success: false,
        error: 'OPENAI_API_KEY not configured',
        message: 'The AI assistant is not configured. Please set OPENAI_API_KEY environment variable.'
      };
    }

    const chatTools = toOpenAITools(toolDefinitions);
    const responseTools = toResponsesTools(toolDefinitions);
    const normalizedHistory = normalizeHistory(conversationHistory);
    const chatMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...normalizedHistory,
      { role: 'user', content: String(userMessage || '') }
    ];
    const responseInput = [
      ...normalizedHistory
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'developer' || m.role === 'system')
        .map((m) => ({ type: 'message', role: m.role, content: m.content })),
      { type: 'message', role: 'user', content: String(userMessage || '') }
    ];

    try {
      const modelsToTry = [OPENAI_MODEL, ...OPENAI_FALLBACK_MODELS].filter(Boolean);
      logger.info({ event: 'chat_request', messageLength: String(userMessage || '').length, model: OPENAI_MODEL, fallbackCount: OPENAI_FALLBACK_MODELS.length });

      let iterations = 0;
      const maxIterations = 6;
      let usedModel = null;

      const createResponsesWithFallback = async ({ input, previousResponseId }) => {
        let lastError = null;
        for (const model of modelsToTry) {
          try {
            const response = await this.client.responses.create({
              model,
              instructions: SYSTEM_PROMPT,
              input,
              tools: responseTools,
              tool_choice: 'auto',
              max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
              ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
            });
            usedModel = model;
            return response;
          } catch (error) {
            lastError = error;
            if (!isModelUnavailableError(error)) throw error;
            logger.warn({ event: 'chat_model_fallback', model, status: error?.status, message: error?.message }, 'Model unavailable; trying fallback');
          }
        }
        throw lastError || new Error('No available OpenAI model');
      };

      const createChatCompletionsWithFallback = async () => {
        let lastError = null;
        for (const model of modelsToTry) {
          try {
            const response = await this.client.chat.completions.create({
              model,
              messages: chatMessages,
              tools: chatTools,
              tool_choice: 'auto',
              max_tokens: OPENAI_MAX_OUTPUT_TOKENS
            });
            usedModel = model;
            return response;
          } catch (error) {
            lastError = error;
            if (!isModelUnavailableError(error)) throw error;
            logger.warn({ event: 'chat_model_fallback', model, status: error?.status, message: error?.message }, 'Model unavailable; trying fallback');
          }
        }
        throw lastError || new Error('No available OpenAI model');
      };

      // Prefer Responses API (best compatibility with newest models), then fallback to Chat Completions if needed.
      let usingResponsesApi = true;
      let previousResponseId = null;
      let pendingToolOutputs = null;

      while (iterations < maxIterations) {
        let response;
        try {
          if (!usingResponsesApi) throw new Error('FORCE_CHAT_COMPLETIONS');
          response = await createResponsesWithFallback({
            input: previousResponseId ? pendingToolOutputs : responseInput,
            previousResponseId
          });
        } catch (error) {
          if (error?.message !== 'FORCE_CHAT_COMPLETIONS') {
            // If the Responses API is not supported for this project/model, fall back to Chat Completions.
            const status = error?.status || error?.response?.status || null;
            logger.warn({ event: 'chat_responses_fallback', status, message: error?.message }, 'Falling back to Chat Completions API');
          }
          usingResponsesApi = false;
          response = await createChatCompletionsWithFallback();
        }

        if (!usingResponsesApi) {
          const choice = response.choices?.[0];
          const assistantMessage = choice?.message || {};
          const toolCalls = assistantMessage.tool_calls || [];

          chatMessages.push({
            role: 'assistant',
            content: assistantMessage.content || '',
            tool_calls: toolCalls.length ? toolCalls : undefined
          });

          if (!toolCalls.length) {
            const text = assistantMessage.content || '';
            return {
              success: true,
              message: text,
              toolsUsed: iterations,
              usage: response.usage || null,
              model: usedModel || OPENAI_MODEL
            };
          }

          iterations += 1;

          for (const call of toolCalls) {
            const toolName = call?.function?.name;
            const rawArgs = call?.function?.arguments || '{}';

            let args = {};
            try {
              args = JSON.parse(rawArgs);
            } catch {
              args = {};
            }

            logger.info({ event: 'tool_call', tool: toolName, args });
            const result = await executeTool(toolName, args || {});

            chatMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(result, null, 2)
            });

            logger.info({ event: 'tool_result', tool: toolName, hasError: Boolean(result?.error) });
          }

          continue;
        }

        // Responses API flow
        previousResponseId = response.id;
        const outputItems = Array.isArray(response.output) ? response.output : [];
        const toolCalls = outputItems.filter((item) => item && item.type === 'function_call');

        if (!toolCalls.length) {
          return {
            success: true,
            message: response.output_text || '',
            toolsUsed: iterations,
            usage: response.usage || null,
            model: usedModel || OPENAI_MODEL
          };
        }

        iterations += 1;

        pendingToolOutputs = [];
        for (const call of toolCalls) {
          const toolName = call?.name;
          const rawArgs = call?.arguments || '{}';

          let args = {};
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = {};
          }

          logger.info({ event: 'tool_call', tool: toolName, args, callId: call?.call_id });
          const result = await executeTool(toolName, args || {});

          pendingToolOutputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result, null, 2)
          });

          logger.info({ event: 'tool_result', tool: toolName, hasError: Boolean(result?.error) });
        }
      }

      return {
        success: false,
        error: 'TOOL_LOOP_LIMIT',
        message: 'AI assistant stopped after too many tool calls. Please try rephrasing.'
      };
    } catch (error) {
      logger.error({ event: 'chat_error', error: error?.message || String(error) });

      const status = error?.status || error?.response?.status || null;
      if (status === 401) {
        return { success: false, error: 'INVALID_API_KEY', message: 'Invalid API key. Please check OPENAI_API_KEY.' };
      }
      if (status === 429) {
        return { success: false, error: 'RATE_LIMITED', message: 'Too many requests. Please try again in a moment.' };
      }

      return { success: false, error: 'CHAT_ERROR', message: `An error occurred: ${error?.message || String(error)}` };
    }
  }
}

module.exports = new ChatService();
