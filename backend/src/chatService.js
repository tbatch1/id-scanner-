// Chat Service - Claude API integration with tool use for business intelligence
const Anthropic = require('@anthropic-ai/sdk');
const { toolDefinitions, executeTool } = require('./chatTools');
const logger = require('./logger');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// System prompt for the AI assistant
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

class ChatService {
  constructor() {
    this.client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  async chat(userMessage, conversationHistory = []) {
    if (!this.client) {
      return {
        success: false,
        error: 'ANTHROPIC_API_KEY not configured',
        message: 'The AI assistant is not configured. Please set ANTHROPIC_API_KEY environment variable.'
      };
    }

    try {
      // Build messages array
      const messages = [
        ...conversationHistory,
        { role: 'user', content: userMessage }
      ];

      logger.info({ event: 'chat_request', messageLength: userMessage.length });

      // Initial API call
      let response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: toolDefinitions,
        messages
      });

      // Handle tool use loop
      let iterations = 0;
      const maxIterations = 5; // Prevent infinite loops

      while (response.stop_reason === 'tool_use' && iterations < maxIterations) {
        iterations++;

        // Find tool use blocks
        const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');

        if (toolUseBlocks.length === 0) break;

        // Execute each tool and collect results
        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          logger.info({
            event: 'tool_call',
            tool: toolUse.name,
            args: toolUse.input
          });

          const result = await executeTool(toolUse.name, toolUse.input || {});

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result, null, 2)
          });

          logger.info({
            event: 'tool_result',
            tool: toolUse.name,
            hasError: Boolean(result.error)
          });
        }

        // Continue conversation with tool results
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });

        response = await this.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: toolDefinitions,
          messages
        });
      }

      // Extract final text response
      const textBlocks = response.content.filter(block => block.type === 'text');
      const assistantMessage = textBlocks.map(block => block.text).join('\n');

      logger.info({
        event: 'chat_response',
        toolIterations: iterations,
        responseLength: assistantMessage.length
      });

      return {
        success: true,
        message: assistantMessage,
        toolsUsed: iterations,
        usage: response.usage
      };

    } catch (error) {
      logger.error({ event: 'chat_error', error: error.message });

      // Handle specific error types
      if (error.status === 401) {
        return {
          success: false,
          error: 'INVALID_API_KEY',
          message: 'Invalid API key. Please check your ANTHROPIC_API_KEY.'
        };
      }

      if (error.status === 429) {
        return {
          success: false,
          error: 'RATE_LIMITED',
          message: 'Too many requests. Please try again in a moment.'
        };
      }

      return {
        success: false,
        error: 'CHAT_ERROR',
        message: `An error occurred: ${error.message}`
      };
    }
  }
}

// Singleton instance
const chatService = new ChatService();

module.exports = chatService;
