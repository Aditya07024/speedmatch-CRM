import {
  date,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const teamMembersTable = pgTable("speedmatch_team_members", {
  id: serial("id").primaryKey(),
  authId: text("auth_id").notNull().unique(),
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("member"),
  companyId: integer("company_id"),
  status: text("status").notNull().default("pending"),
  avatarUrl: text("avatar_url"),
  requestMessage: text("request_message"),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const invitationsTable = pgTable("speedmatch_invitations", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("pending"),
  invitedBy: text("invited_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const companiesTable = pgTable("speedmatch_companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  industry: text("industry").notNull().default("Other"),
  website: text("website").notNull().default(""),
  size: text("size").notNull().default("1-10"),
  status: text("status").notNull().default("Prospect"),
  owner: text("owner").notNull().default("Unassigned"),
  initiationCode: text("initiation_code").notNull().default("SPEEDMATCH2026"),
  adminEmail: text("admin_email"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaceSettingsTable = pgTable("speedmatch_workspace_settings", {
  id: serial("id").primaryKey(),
  initiationCode: text("initiation_code").notNull().default("SPEEDMATCH2026"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const contactsTable = pgTable("speedmatch_contacts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company").notNull().default(""),
  role: text("role").notNull().default(""),
  status: text("status").notNull().default("New"),
  source: text("source").notNull().default("Referral"),
  owner: text("owner").notNull().default("Unassigned"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const dealsTable = pgTable("speedmatch_deals", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  company: text("company").notNull().default(""),
  contact: text("contact").notNull().default(""),
  value: integer("value").notNull().default(0),
  stage: text("stage").notNull().default("Lead"),
  probability: integer("probability").notNull().default(10),
  owner: text("owner").notNull().default("Unassigned"),
  expectedClose: date("expected_close", { mode: "string" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tasksTable = pgTable("speedmatch_tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type").notNull().default("Follow-up"),
  dueDate: date("due_date", { mode: "string" }),
  status: text("status").notNull().default("Open"),
  priority: text("priority").notNull().default("Normal"),
  owner: text("owner").notNull().default("Unassigned"),
  contact: text("contact"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const conversationsTable = pgTable("speedmatch_conversations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default(""),
  type: text("type").notNull().default("direct"),
  createdBy: integer("created_by")
    .notNull()
    .references(() => teamMembersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const conversationMembersTable = pgTable(
  "speedmatch_conversation_members",
  {
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => teamMembersTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.memberId] })],
);

export const messagesTable = pgTable("speedmatch_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  senderId: integer("sender_id")
    .notNull()
    .references(() => teamMembersTable.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const communityPostsTable = pgTable("speedmatch_community_posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id")
    .notNull()
    .references(() => teamMembersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  category: text("category").notNull().default("General"),
  likes: integer("likes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const communityCommentsTable = pgTable(
  "speedmatch_community_comments",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id")
      .notNull()
      .references(() => communityPostsTable.id, { onDelete: "cascade" }),
    authorId: integer("author_id")
      .notNull()
      .references(() => teamMembersTable.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const activitiesTable = pgTable("speedmatch_activities", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});