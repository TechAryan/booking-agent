// The AI providers a business can pick. Claude first and recommended; the rest sit under "Other AI options".
// Version names come from each provider's docs; "More versions" reads the live list, so new models appear by themselves.
import { callJson } from "./http.js";
import { baseOf } from "./openai-compat.js";
import { AIError, ProviderSpec } from "./types.js";

const notChat = /(embed|tts|audio|realtime|transcribe|image|dall-e|whisper|moderation|search|computer-use|live|veo|imagen|aqa|learnlm|instruct|babbage|davinci)/i;

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic", name: "Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com", vision: true,
    versions: [
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", tag: "Recommended" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", tag: "Cheaper" },
      { id: "claude-opus-5-5", label: "Opus 5.5", tag: "Smartest" },
    ],
    keyPrefix: "sk-ant-", keyPlaceholder: "sk-ant-api03-…", consoleUrl: "https://platform.claude.com", pricingUrl: "https://claude.com/pricing#api",
    steps: [
      "Open [platform.claude.com](https://platform.claude.com) and sign up.",
      "Go to **Settings → Billing → Buy credits**. Use a Visa or Mastercard with international payments on; UPI and RuPay don't work ([how to pay](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-api-usage)). $5 lasts a small business weeks.",
      "Go to **Settings → API keys → Create key**, name it `booking-assistant`, and copy it.",
      "Paste it below, pick a version, and press **Test and save**.",
    ],
  },
  {
    id: "gemini", name: "Gemini (Google)", adapter: "openai-compat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", vision: true,
    versions: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", tag: "Recommended" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", tag: "Cheaper" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", tag: "Smartest" },
    ],
    keyPrefix: "AI", keyPlaceholder: "AIza…", consoleUrl: "https://aistudio.google.com", pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    note: "Google's free tier allows only a few chats a day and Google may use them to improve its products. Turn on billing before real customers use it.",
    modelFilter: (id) => /^gemini-/.test(id) && !notChat.test(id),
    steps: [
      "Open [aistudio.google.com](https://aistudio.google.com), sign in with Google, and open **Get API key → Create API key**.",
      "For real customers, click **Set up billing** and prepay at least $5 ([billing](https://ai.google.dev/gemini-api/docs/billing)).",
      "Paste the key below, pick a version, and press **Test and save**.",
    ],
  },
  {
    id: "openai", name: "OpenAI (ChatGPT)", adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", vision: true,
    versions: [
      { id: "gpt-6-luna", label: "GPT-6 Luna", tag: "Recommended" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", tag: "Smartest" },
    ],
    keyPrefix: "sk-", keyPlaceholder: "sk-proj-…", consoleUrl: "https://platform.openai.com", pricingUrl: "https://openai.com/api/pricing/",
    note: "A ChatGPT Plus subscription doesn't include the API. API credit is bought separately.",
    modelFilter: (id) => /^(gpt-|o\d|chatgpt)/.test(id) && !notChat.test(id),
    steps: [
      "Open [platform.openai.com](https://platform.openai.com) and sign up.",
      "Open **Billing → Add payment details** and buy at least $5 of credit ([prepaid billing](https://help.openai.com/en/articles/8264644-how-does-prepaid-billing-work)).",
      "Open **API keys → Create new secret key**, and copy it.",
      "Paste it below, pick a version, and press **Test and save**.",
    ],
  },
  {
    id: "deepseek", name: "DeepSeek", adapter: "openai-compat", baseUrl: "https://api.deepseek.com", vision: false,
    versions: [
      { id: "deepseek-flash", label: "DeepSeek Flash", tag: "Recommended" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", tag: "Smartest" },
    ],
    keyPrefix: "sk-", keyPlaceholder: "sk-…", consoleUrl: "https://platform.deepseek.com", pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    note: "Chats are processed on DeepSeek's servers in China. DeepSeek can't read payment screenshots, so those go to you to check.",
    extraBody: { thinking: { type: "disabled" } }, // thinking mode needs its reasoning sent back on every tool call; off is faster and cheaper
    keyInfo: async (key) => {
      const p = PROVIDERS.find((x) => x.id === "deepseek")!;
      const j = await callJson(`${baseOf(p)}/user/balance`, { headers: { Authorization: `Bearer ${key}` } }, "DeepSeek");
      if (j && j.is_available === false) throw new AIError("credit", "The DeepSeek key works, but the balance is empty. Top up in DeepSeek's billing page.");
      const b = j?.balance_infos?.[0];
      return b ? `Balance: ${b.total_balance} ${b.currency}` : null;
    },
    steps: [
      "Open [platform.deepseek.com](https://platform.deepseek.com) and sign up.",
      "Open **Top up** and add balance.",
      "Open **API keys**, create one, and copy it.",
      "Paste it below, pick a version, and press **Test and save**.",
    ],
  },
  {
    id: "sarvam", name: "Sarvam (Indian)", adapter: "openai-compat", baseUrl: "https://api.sarvam.ai/v1", vision: false,
    versions: [
      { id: "sarvam-105b", label: "Sarvam 105B", tag: "Recommended" },
      { id: "sarvam-105b-conversations", label: "Sarvam 105B Conversations (faster)" },
    ],
    keyPrefix: "sk_", keyPlaceholder: "sk_…", consoleUrl: "https://dashboard.sarvam.ai", pricingUrl: "https://docs.sarvam.ai/api/pricing",
    note: "Made in India, strong in Indian languages; you pay in rupees. It can't read payment screenshots, so those go to you to check.",
    extraBody: { reasoning_effort: null }, // reasoning off: quicker replies for chat
    modelFilter: (id) => /^sarvam-/.test(id),
    steps: [
      "Open [dashboard.sarvam.ai](https://dashboard.sarvam.ai) and sign up; you get ₹100 free credit ([pricing](https://docs.sarvam.ai/api/pricing)).",
      "Add credit in rupees under **Billing** when needed.",
      "Copy your **API key** from the dashboard.",
      "Paste it below, pick a version, and press **Test and save**.",
    ],
  },
  {
    id: "openrouter", name: "OpenRouter (many AIs, one key)", adapter: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", vision: true,
    versions: [
      { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 via OpenRouter", tag: "Recommended" },
      { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 via OpenRouter", tag: "Cheaper" },
      { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash via OpenRouter" },
    ],
    keyPrefix: "sk-or-", keyPlaceholder: "sk-or-v1-…", consoleUrl: "https://openrouter.ai", pricingUrl: "https://openrouter.ai/models",
    note: "Only versions that can use tools (needed for booking) are listed. Card top-ups carry OpenRouter's fee.",
    headers: { "HTTP-Referer": "https://booking-agent.app", "X-Title": "Booking assistant" },
    keyInfo: async (key) => {
      const p = PROVIDERS.find((x) => x.id === "openrouter")!;
      const j = await callJson(`${baseOf(p)}/key`, { headers: { Authorization: `Bearer ${key}` } }, "OpenRouter");
      const d = j?.data ?? {};
      if (typeof d.limit_remaining === "number" && d.limit_remaining <= 0) throw new AIError("credit", "This OpenRouter key has used up its credit limit. Raise it or add credit in OpenRouter.");
      return typeof d.limit_remaining === "number" ? `Credit left on this key: $${d.limit_remaining.toFixed(2)}` : null;
    },
    steps: [
      "Open [openrouter.ai](https://openrouter.ai) and sign up.",
      "Buy credits ([FAQ](https://openrouter.ai/docs/faq)).",
      "Open **Keys → Create key**, and copy it.",
      "Paste it below, pick a version, and press **Test and save**.",
    ],
  },
];

export const providerById = (id: string | null | undefined) => PROVIDERS.find((p) => p.id === id);
export const DEFAULT_PROVIDER = PROVIDERS[0]!;

/** Display name for a model id: curated label, or the id itself. */
export function versionLabel(p: ProviderSpec, model: string) {
  return p.versions.find((v) => v.id === model)?.label ?? model;
}
