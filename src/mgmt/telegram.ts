import type { Api } from 'grammy';
import type { BotTransport, InlineButton } from './bot.js';

/**
 * grammY binding for the transport-agnostic ManagementBot. Translates the
 * bot's abstract calls into Telegram Bot API calls. Kept deliberately thin —
 * all logic lives in bot.ts/broker.ts, which are tested without Telegram.
 */
export class GrammyTransport implements BotTransport {
  constructor(private readonly api: Api) {}

  async sendMessage(chatId: number, text: string, buttons?: InlineButton[][]) {
    const reply_markup = buttons?.length
      ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
      : undefined;
    const msg = await this.api.sendMessage(chatId, text, reply_markup ? { reply_markup } : {});
    return { messageId: msg.message_id };
  }

  async editMessage(chatId: number, messageId: number, text: string) {
    // Ignore "message is not modified" and races on an already-edited card.
    await this.api.editMessageText(chatId, messageId, text).catch(() => {});
  }

  async answerCallback(callbackId: string, text?: string) {
    await this.api.answerCallbackQuery(callbackId, text ? { text } : {}).catch(() => {});
  }
}
