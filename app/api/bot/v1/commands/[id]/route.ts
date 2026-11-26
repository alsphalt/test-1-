import { prisma } from "@/lib/db";
import { publish } from "@/lib/events";
import { assertSameOrigin, json, notFound, readJson, route } from "@/lib/http";
import { requireBot } from "@/lib/botAgent";
import { botCommandResultSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** Ack a command so the UI can stop saying "restart pending". */
export const POST = route(async (req: Request, { params }: Ctx) => {
  assertSameOrigin(req);
  const bot = await requireBot(req);
  const input = botCommandResultSchema.parse(await readJson<unknown>(req));

  const command = await prisma.botCommand.findFirst({
    where: { id: params.id, botId: bot.id },
    select: { id: true, sessionId: true, type: true },
  });
  if (!command) throw notFound("Command not found");

  await prisma.botCommand.update({
    where: { id: command.id },
    data: {
      status: input.status,
      result: (input.result || "").slice(0, 300),
      completedAt: new Date(),
    },
  });

  if (command.sessionId) {
    await prisma.whatsAppLog.create({
      data: {
        sessionId: command.sessionId,
        level: input.status === "DONE" ? "INFO" : "ERROR",
        message: `${command.type} ${input.status.toLowerCase()}${input.result ? `: ${input.result}` : ""}`,
      },
    });
  }

  publish(bot.userId, "whatsapp.updated", { id: command.sessionId, command: command.type });
  return json({ ok: true });
});
