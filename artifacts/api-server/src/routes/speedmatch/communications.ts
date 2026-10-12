import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  communityCommentsTable,
  communityPostsTable,
  conversationMembersTable,
  conversationsTable,
  db,
  messagesTable,
  teamMembersTable,
} from "@workspace/db";
import {
  CreateCommunityCommentBody,
  CreateCommunityCommentParams,
  CreateCommunityCommentResponse,
  CreateCommunityPostBody,
  CreateCommunityPostResponse,
  CreateConversationBody,
  CreateConversationResponse,
  CreateMessageBody,
  CreateMessageParams,
  CreateMessageResponse,
  ListCommunityPostsResponse,
  ListConversationsResponse,
  ListMessagesParams,
  ListMessagesResponse,
} from "@workspace/api-zod";
import { getRequestMember } from "../../lib/speedmatch-auth";
import { addActivity, asIso, parseRouteId } from "../../lib/speedmatch-utils";

const router: IRouter = Router();

async function buildConversation(
  conversation: typeof conversationsTable.$inferSelect,
  currentMemberId: number,
) {
  const participants = await db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
    })
    .from(conversationMembersTable)
    .innerJoin(
      teamMembersTable,
      eq(conversationMembersTable.memberId, teamMembersTable.id),
    )
    .where(eq(conversationMembersTable.conversationId, conversation.id));
  const [lastMessage] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversation.id))
    .orderBy(desc(messagesTable.createdAt))
    .limit(1);
  const other = participants.find((participant) => participant.id !== currentMemberId);
  return {
    id: conversation.id,
    name:
      conversation.type === "direct" && (!conversation.name || !conversation.name.trim())
        ? other?.name ?? "Direct message"
        : conversation.name,
    type: conversation.type,
    memberNames: participants.map((participant) => participant.name),
    lastMessage: lastMessage?.body ?? null,
    unreadCount: 0,
    updatedAt: asIso(conversation.updatedAt),
  };
}

router.get("/conversations", async (_req, res): Promise<void> => {
  const member = getRequestMember(res);
  const memberships = await db
    .select({ conversationId: conversationMembersTable.conversationId })
    .from(conversationMembersTable)
    .where(eq(conversationMembersTable.memberId, member.id));
  const ids = memberships.map((item) => item.conversationId);
  if (!ids.length) {
    res.json(ListConversationsResponse.parse([]));
    return;
  }
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(inArray(conversationsTable.id, ids))
    .orderBy(desc(conversationsTable.updatedAt));
  const result = await Promise.all(
    conversations.map((conversation) =>
      buildConversation(conversation, member.id),
    ),
  );
  res.json(ListConversationsResponse.parse(result));
});

router.post("/conversations", async (req, res): Promise<void> => {
  const parsed = CreateConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const member = getRequestMember(res);
  const memberIds = [...new Set([...parsed.data.memberIds, member.id])];
  if (parsed.data.type === "direct" && memberIds.length !== 2) {
    res.status(400).json({ error: "A direct conversation needs one other teammate" });
    return;
  }
  const participants = await db
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(
      inArray(teamMembersTable.id, memberIds),
    );
  if (participants.length !== memberIds.length) {
    res.status(400).json({ error: "One or more teammates could not be found" });
    return;
  }
  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      name: parsed.data.name,
      type: parsed.data.type,
      createdBy: member.id,
    })
    .returning();
  await db.insert(conversationMembersTable).values(
    memberIds.map((memberId) => ({ conversationId: conversation.id, memberId })),
  );
  await addActivity("message", "Conversation started", conversation.name || "Direct message");
  res
    .status(201)
    .json(
      CreateConversationResponse.parse(
        await buildConversation(conversation, member.id),
      ),
    );
});

router.get(
  "/conversations/:id/messages",
  async (req, res): Promise<void> => {
    const params = ListMessagesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const member = getRequestMember(res);
    const [membership] = await db
      .select()
      .from(conversationMembersTable)
      .where(
        and(
          eq(conversationMembersTable.conversationId, params.data.id),
          eq(conversationMembersTable.memberId, member.id),
        ),
      );
    if (!membership) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const rows = await db
      .select({
        id: messagesTable.id,
        conversationId: messagesTable.conversationId,
        senderId: messagesTable.senderId,
        senderName: teamMembersTable.name,
        body: messagesTable.body,
        createdAt: messagesTable.createdAt,
      })
      .from(messagesTable)
      .innerJoin(teamMembersTable, eq(messagesTable.senderId, teamMembersTable.id))
      .where(eq(messagesTable.conversationId, params.data.id))
      .orderBy(messagesTable.createdAt);
    res.json(
      ListMessagesResponse.parse(
        rows.map((row) => ({ ...row, createdAt: asIso(row.createdAt) })),
      ),
    );
  },
);

router.post(
  "/conversations/:id/messages",
  async (req, res): Promise<void> => {
    const params = CreateMessageParams.safeParse(req.params);
    const body = CreateMessageBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: params.error?.message ?? body.error?.message });
      return;
    }
    const member = getRequestMember(res);
    const [membership] = await db
      .select()
      .from(conversationMembersTable)
      .where(
        and(
          eq(conversationMembersTable.conversationId, params.data.id),
          eq(conversationMembersTable.memberId, member.id),
        ),
      );
    if (!membership) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const [message] = await db
      .insert(messagesTable)
      .values({
        conversationId: params.data.id,
        senderId: member.id,
        body: body.data.body,
      })
      .returning();
    await db
      .update(conversationsTable)
      .set({ updatedAt: new Date() })
      .where(eq(conversationsTable.id, params.data.id));
    await addActivity("message", "Message sent", body.data.body.slice(0, 100));
    res.status(201).json(
      CreateMessageResponse.parse({
        ...message,
        senderName: member.name,
        createdAt: asIso(message.createdAt),
      }),
    );
  },
);

router.get("/community/posts", async (_req, res): Promise<void> => {
  const posts = await db
    .select({
      id: communityPostsTable.id,
      authorId: communityPostsTable.authorId,
      author: teamMembersTable.name,
      title: communityPostsTable.title,
      body: communityPostsTable.body,
      category: communityPostsTable.category,
      likes: communityPostsTable.likes,
      createdAt: communityPostsTable.createdAt,
    })
    .from(communityPostsTable)
    .innerJoin(teamMembersTable, eq(communityPostsTable.authorId, teamMembersTable.id))
    .orderBy(desc(communityPostsTable.createdAt));
  const result = await Promise.all(
    posts.map(async (post) => {
      const comments = await db
        .select({
          id: communityCommentsTable.id,
          author: teamMembersTable.name,
          body: communityCommentsTable.body,
          createdAt: communityCommentsTable.createdAt,
        })
        .from(communityCommentsTable)
        .innerJoin(
          teamMembersTable,
          eq(communityCommentsTable.authorId, teamMembersTable.id),
        )
        .where(eq(communityCommentsTable.postId, post.id))
        .orderBy(communityCommentsTable.createdAt);
      return {
        id: post.id,
        author: post.author,
        title: post.title,
        body: post.body,
        category: post.category,
        likes: post.likes,
        createdAt: asIso(post.createdAt),
        comments: comments.map((comment) => ({
          ...comment,
          createdAt: asIso(comment.createdAt),
        })),
      };
    }),
  );
  res.json(ListCommunityPostsResponse.parse(result));
});

router.post("/community/posts", async (req, res): Promise<void> => {
  const parsed = CreateCommunityPostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const member = getRequestMember(res);
  const [post] = await db
    .insert(communityPostsTable)
    .values({
      authorId: member.id,
      title: parsed.data.title,
      body: parsed.data.body,
      category: parsed.data.category ?? "General",
    })
    .returning();
  await addActivity("community", "Community post published", post.title);
  res.status(201).json(
    CreateCommunityPostResponse.parse({
      id: post.id,
      author: member.name,
      title: post.title,
      body: post.body,
      category: post.category,
      likes: post.likes,
      createdAt: asIso(post.createdAt),
      comments: [],
    }),
  );
});

router.post(
  "/community/posts/:id/comments",
  async (req, res): Promise<void> => {
    const params = CreateCommunityCommentParams.safeParse(req.params);
    const body = CreateCommunityCommentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: params.error?.message ?? body.error?.message });
      return;
    }
    const [post] = await db
      .select()
      .from(communityPostsTable)
      .where(eq(communityPostsTable.id, params.data.id))
      .limit(1);
    if (!post) {
      res.status(404).json({ error: "Community post not found" });
      return;
    }
    const member = getRequestMember(res);
    const [comment] = await db
      .insert(communityCommentsTable)
      .values({
        postId: params.data.id,
        authorId: member.id,
        body: body.data.body,
      })
      .returning();
    await addActivity("community", "Community post commented on", post.title);
    res.status(201).json(
      CreateCommunityCommentResponse.parse({
        id: comment.id,
        author: member.name,
        body: comment.body,
        createdAt: asIso(comment.createdAt),
      }),
    );
  },
);

export default router;