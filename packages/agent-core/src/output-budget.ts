/** Normal complex structured-output budget for generation stages. */
export const GENERATION_OUTPUT_TOKENS = 64_000;
/** Focused title/body generation and identity-repair budget. */
export const GENERATION_CORE_OUTPUT_TOKENS = 32_000;
/** Short answer and compact review-stage budget. */
export const GENERATION_SHORT_OUTPUT_TOKENS = 16_000;
/** DeepSeek capability used only after an explicit length stop. */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000;
