import { Hono } from "hono";
import { z } from "zod";
import type { Client } from "@libsql/client";
import { authenticate } from "../middleware/auth";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool, isStepCount } from "ai";
import { getDb } from "../db";
import { sendMessage, type MailerConfig } from "../lib/mailer";
import { sendText } from "../lib/whatsapp";
import { insertEvent } from "../lib/events";

/** This user's own Gmail credentials (set by an admin), falling back to the
 * global env vars for accounts with none configured. */
async function userMailerConfig(db: Client, userId: number): Promise<MailerConfig> {
  const row = (
    await db.execute({ sql: "SELECT gmail_email, gmail_app_password FROM users WHERE id = ?", args: [userId] })
  ).rows[0] as unknown as { gmail_email: string | null; gmail_app_password: string | null } | undefined;
  const user = row?.gmail_email || process.env.GMAIL_USER;
  const appPassword = row?.gmail_app_password || process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("No email account configured for this user — ask your admin to set one in the Admin panel.");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com",
  };
}

const router = new Hono();

const MODEL = process.env.AI_MODEL ?? "openai/gpt-5.6-luna";

function gateway() {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("Missing AI_API_KEY or AI_BASE_URL");
  return createOpenAICompatible({ name: "ai-provider", apiKey, baseURL });
}

function leadsBlock(leads: LeadCtx[]) {
  return leads
    .map((l) => {
      const budget = l.budget_max ? `$${Number(l.budget_max).toLocaleString()}` : "";
      const extras = [
        l.interest ? `interest=${l.interest}` : "",
        l.category ? `category=${l.category}` : "",
        l.region ? `region=${l.region}` : "",
        budget ? `budget=${budget}` : "",
        l.urgency ? `urgency=${l.urgency}` : "",
        l.notes ? `notes="${l.notes}"` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `- [${l.id.slice(0, 8)}] ${l.name} · ${l.company ?? ""} · ${l.city ?? ""} · email=${l.email ?? "—"} · phone=${l.phone ?? "—"} · status=${l.status} · score=${l.score}${extras ? ` · ${extras}` : ""}`;
    })
    .join("\n");
}

type LeadCtx = { id: string; name: string; company: string | null; email: string | null; phone: string | null; city: string | null; status: string; score: number; notes?: string | null; interest?: string | null; category?: string | null; region?: string | null; budget_max?: number | null; urgency?: string | null };

const historySchema = z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }));

// Real tools the assistant can invoke — actually send emails / WhatsApp
// messages when the user explicitly asks. Sends are recorded in the same
// tables the Email Studio / WhatsApp pages read, so they show up there.
// Built per-request so lead lookups stay scoped to the calling user — one
// user's chat must never be able to email/WhatsApp another user's lead.
function buildChatTools(userId: number) {
  return {
  send_email: tool({
    description:
      "Send a real email to a lead through the connected inbox (SMTP). The email is delivered immediately and recorded in Email Studio. Call this when the user asks to send, email, or mail a lead — compose the subject and body yourself from the lead's details and requirements.",
    inputSchema: z.object({
      lead_id: z.string().describe("The lead's id — its full UUID or the first 8 characters shown in the leads list."),
      subject: z.string().describe("Email subject line."),
      body: z.string().describe("Plain-text email body. Personalize with the lead's name and their specific needs."),
    }),
    execute: async ({ lead_id, subject, body }) => {
      const db = await getDb();
      const lead = (await db.execute({ sql: "SELECT * FROM leads WHERE (id = ? OR substr(id, 1, 8) = ?) AND user_id = ? LIMIT 1", args: [lead_id, lead_id, userId] })).rows[0] as unknown as
        | { id: string; name: string | null; email: string | null }
        | undefined;
      if (!lead) return { ok: false, error: `No lead found with id ${lead_id}` };
      if (!lead.email) return { ok: false, error: `Lead ${lead.name ?? lead_id} has no email address on file — add one first` };
      let mailCfg: MailerConfig;
      try {
        mailCfg = await userMailerConfig(db, userId);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const id = crypto.randomUUID();
      await db.execute({
        sql: "INSERT INTO email_messages (id, lead_id, subject, body, direction, status, created_at) VALUES (?, ?, ?, ?, 'outbound', 'draft', ?)",
        args: [id, lead.id, subject, body, new Date().toISOString()],
      });
      try {
        const sent = await sendMessage({ to: lead.email, subject, text: body }, mailCfg);
        const now = new Date().toISOString();
        await db.execute({
          sql: "UPDATE email_messages SET status = 'sent', sent_at = ?, from_email = ?, to_email = ?, agentmail_message_id = ?, agentmail_thread_id = ? WHERE id = ?",
          args: [now, mailCfg.user, lead.email, sent.message_id ?? null, sent.thread_id ?? null, id],
        });
        await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, lead.id] });
        await insertEvent(db, {
          lead_id: lead.id,
          channel: "email",
          type: "email",
          direction: "outbound",
          handled_by: "human",
          action: "sent",
          summary: subject,
          content: body,
          source_ref: id,
          metadata: { to: lead.email, message_id: sent.message_id ?? null, via: "ai-chat" },
          created_at: now,
        });
        return { ok: true, email_id: id, to: lead.email, subject };
      } catch (e) {
        // SMTP failed — keep the row as a draft so nothing is lost.
        await db.execute({ sql: "UPDATE email_messages SET status = 'draft' WHERE id = ?", args: [id] });
        return { ok: false, error: `Sending failed: ${(e as Error).message}. The email was saved as a draft in Email Studio.` };
      }
    },
  }),
  send_whatsapp: tool({
    description:
      "Send a real WhatsApp message to a lead. The message is delivered immediately and recorded in WhatsApp. Call this when the user asks to send a WhatsApp or message a lead.",
    inputSchema: z.object({
      lead_id: z.string().describe("The lead's id — its full UUID or the first 8 characters shown in the leads list."),
      body: z.string().describe("WhatsApp message text, 1-3 sentences, personalized with the lead's name and needs."),
    }),
    execute: async ({ lead_id, body }) => {
      const db = await getDb();
      const lead = (await db.execute({ sql: "SELECT * FROM leads WHERE (id = ? OR substr(id, 1, 8) = ?) AND user_id = ? LIMIT 1", args: [lead_id, lead_id, userId] })).rows[0] as unknown as
        | { id: string; name: string | null; phone: string | null }
        | undefined;
      if (!lead) return { ok: false, error: `No lead found with id ${lead_id}` };
      if (!lead.phone) return { ok: false, error: `Lead ${lead.name ?? lead_id} has no phone number on file — add one first` };
      const id = crypto.randomUUID();
      await db.execute({
        sql: "INSERT INTO whatsapp_messages (id, lead_id, body, direction, to_number, status, created_at) VALUES (?, ?, ?, 'outbound', ?, 'draft', ?)",
        args: [id, lead.id, body, lead.phone, new Date().toISOString()],
      });
      try {
        const send = await sendText(lead.phone, body);
        if (!send.ok) throw new Error(send.error ?? "WhatsApp send failed");
        const now = new Date().toISOString();
        await db.execute({
          sql: "UPDATE whatsapp_messages SET status = 'sent', sent_at = ?, provider_message_id = ? WHERE id = ?",
          args: [now, send.providerMessageId, id],
        });
        await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, lead.id] });
        await insertEvent(db, {
          lead_id: lead.id,
          channel: "whatsapp",
          type: "whatsapp",
          direction: "outbound",
          handled_by: "human",
          action: "sent",
          summary: body.slice(0, 120),
          content: body,
          source_ref: id,
          metadata: { to: lead.phone, provider_message_id: send.providerMessageId, via: "ai-chat" },
          created_at: now,
        });
        return { ok: true, message_id: id, to: lead.phone };
      } catch (e) {
        await db.execute({ sql: "UPDATE whatsapp_messages SET status = 'draft' WHERE id = ?", args: [id] });
        return { ok: false, error: `Sending failed: ${(e as Error).message}. The message was saved as a draft in WhatsApp.` };
      }
    },
  }),
  };
}

router.post("/chat", async (c) => {
  const authedUser = await authenticate(c);
  if (!authedUser) return c.json({ error: "Unauthorized" }, 401);
  const { question, leads, history } = z
    .object({ question: z.string(), leads: z.array(z.any()), history: historySchema.optional() })
    .parse(await c.req.json());
  const ai = gateway();
  let text: string;
  try {
    const res = await generateText({
      model: ai(MODEL),
      system:
        "You are an assistant for a lead-management CRM (prospects, customers, deals). Answer ONLY using the provided leads data. Be concise. Cite leads as [lead:FULL_ID]. Do not invent leads or their data, and never substitute a different lead when the one being discussed lacks a field — say that field is missing instead. The conversation may reference a lead named earlier in the thread — use that context to resolve follow-up questions (e.g. \"his email\" or \"show me his number\" refers to the lead just discussed, not a different one). " +
        "You have two real tools: send_email and send_whatsapp. Use them ONLY when the user explicitly asks you to send an email or WhatsApp message to a specific lead. Compose the content yourself from the lead's requirements. After a tool succeeds, confirm briefly what was sent and to whom. If a tool reports an error, tell the user what happened and what they can do (e.g. add the missing email/phone, or send from Email Studio).",
      messages: [
        { role: "user", content: `Leads (${leads.length}):\n${leadsBlock(leads as LeadCtx[])}` },
        ...(history ?? []),
        { role: "user", content: question },
      ],
      tools: buildChatTools(authedUser.id),
      stopWhen: isStepCount(5),
      // The gateway rejects function tools combined with reasoning_effort on
      // this model (/v1/chat/completions) — explicitly disable reasoning so
      // tool calling is allowed.
      providerOptions: { "ai-provider": { reasoningEffort: "none" } },
    });
    text = res.text;
  } catch (e) {
    console.error("[ai/chat] generateText failed:", e);
    throw e;
  }
  const ids = Array.from(text.matchAll(/\[lead:([a-z0-9-]{8,})\]/gi)).map((m) => m[1]);
  const cited = Array.from(new Set(ids)).map((short) => (leads as LeadCtx[]).find((l) => l.id.startsWith(short))?.id).filter(Boolean) as string[];
  return c.json({ text, citations: cited });
});

router.post("/email", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const { lead, tone, goal, senderName } = z.object({ lead: z.any(), tone: z.string(), goal: z.string(), senderName: z.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL), system: `You write short, high-converting sales and outreach emails for a small business (introductions, proposals, follow-ups, check-ins). Reply as strict JSON: {"subject":"...","body":"..."}. Keep body under 110 words. Sign as ${senderName ?? "Jordan"}.`, prompt: `Tone: ${tone}\nGoal: ${goal}\nLead: ${JSON.stringify(lead)}`,
  });
  try { const j = JSON.parse(text.replace(/```json|```/g, "").trim()); return c.json({ subject: j.subject ?? "", body: j.body ?? "" }); } catch { return c.json({ subject: "", body: text }); }
});

router.post("/whatsapp", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const { lead, intent } = z.object({ lead: z.any(), intent: z.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL), system: "Write a friendly, concise follow-up WhatsApp message (1-3 sentences, max 280 chars) — e.g. appointment reminders, quick check-ins, or next-step updates. Use the lead's first name. One emoji max. Return ONLY the message body.", prompt: `Intent: ${intent}\nLead: ${JSON.stringify(lead)}`,
  });
  return c.json({ body: text.trim().replace(/^"|"$/g, "") });
});

router.post("/call", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const { lead, goal } = z.object({ lead: z.any(), goal: z.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL), system: "Design AI voice agent call flows for a sales team (qualify prospects, book meetings, discuss proposals). Return strict JSON: {\"opening\":\"...\",\"talking_points\":[\"...\"],\"objection_handling\":[\"...\"],\"closing\":\"...\",\"mock_transcript\":[{\"speaker\":\"agent|lead\",\"text\":\"...\"}],\"summary\":\"...\",\"suggested_outcome\":\"booked|interested|callback|not_interested|voicemail\",\"book_appointment\":true|false}. Transcript should be 6-10 turns.", prompt: `Call goal: ${goal}\nLead: ${JSON.stringify(lead)}`,
  });
  try { return c.json(JSON.parse(text.replace(/```json|```/g, "").trim())); } catch { return c.json({ suggested_outcome: "callback", book_appointment: false, summary: text, mock_transcript: [] }); }
});

router.post("/post", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const { topic, platform, audience, tone } = z
    .object({ topic: z.string().min(1), platform: z.string().optional(), audience: z.string().optional(), tone: z.string().optional() })
    .parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system:
      "You are a social media copywriter for a small business (product updates, launches, customer wins, industry insights). Return strict JSON: {\"caption\":\"...\",\"hashtags\":[\"#tag\",\"#tag\"],\"image_prompt\":\"...\"}. " +
      "The caption must be ready to post: 1-3 short paragraphs, 1-2 emojis, natural line breaks, tailored to the platform and audience. " +
      "Hashtags: exactly 5-8 relevant tags as an array of strings including the # (e.g. #NewProduct, #BehindTheScenes, #CustomerStory, location tags). " +
      "image_prompt: a detailed English visual prompt (150-220 words) describing a striking, on-brand image for this post — subject, composition, lighting, colors, mood, and any text/graphic elements.",
    prompt: `Topic: ${topic}\nPlatform: ${platform ?? "Instagram"}\nTarget audience: ${audience || "general"}\nTone: ${tone || "energetic and inspiring"}`,
  });
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim());
    return c.json({
      caption: j.caption ?? "",
      hashtags: Array.isArray(j.hashtags) ? j.hashtags.map(String) : [],
      image_prompt: j.image_prompt ?? topic,
    });
  } catch {
    return c.json({ caption: text, hashtags: [], image_prompt: topic });
  }
});

router.post("/image", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const { prompt, size } = z.object({ prompt: z.string(), size: z.string().optional() }).parse(await c.req.json());
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) return c.json({ error: "Missing AI_API_KEY or AI_BASE_URL" }, 500);
  const model = process.env.AI_IMAGE_MODEL ?? "gpt-image-2";
  const endpoint = `${baseURL.replace(/\/+$/, "")}/images/generations`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size: size ?? "auto" }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text();
    return c.json({ error: `Image generation failed (${upstream.status}): ${detail.slice(0, 500)}` }, 502);
  }
  const json = (await upstream.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) return c.json({ image: `data:image/png;base64,${item.b64_json}` });
  if (item?.url) return c.json({ image: item.url });
  return c.json({ error: "No image returned by the model" }, 502);
});

export default router;
