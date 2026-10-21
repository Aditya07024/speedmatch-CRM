import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { MutationCache, QueryClient, QueryClientProvider, useQueryClient, useQuery } from '@tanstack/react-query';
import { Route, Switch, Redirect, Router as WouterRouter, Link, useLocation } from 'wouter';
import { ClerkProvider, SignIn as ClerkSignIn, SignUp as ClerkSignUp, useUser } from '@clerk/clerk-react';
import {
  Activity as ActivityIcon, ArrowUpRight, Bell, BriefcaseBusiness, Building2, CalendarDays,
  Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, Clock3, Compass,
  ContactRound, Ellipsis, Filter, Inbox, LayoutDashboard, LogOut, MessageCircle, Plus, Search,
  Send, Sparkles, Target, TrendingUp, UserPlus, Users, X, ListTodo,
  Pencil, Trash2, RotateCw, ArrowRight, ShieldCheck, Mail, LockKeyhole, Menu, Globe2, MessageSquareText,
  ShieldAlert, KeyRound, AlertCircle, UserCheck, Download, Kanban, List, Trophy, Layers,
  Phone, Video, FileSpreadsheet, NotebookPen, StickyNote, Pin, Share2, Copy, HelpCircle, LifeBuoy, MessageSquareHeart, Tag
} from 'lucide-react';
import {
  useGetDashboardSummary, getGetDashboardSummaryQueryKey, useGetDashboardActivity, getGetDashboardActivityQueryKey,
  useGetAnalytics, getGetAnalyticsQueryKey,
  useListContacts, getListContactsQueryKey, useCreateContact, useUpdateContact, useDeleteContact,
  useListCompanies, getListCompaniesQueryKey, useCreateCompany, useUpdateCompany, useDeleteCompany,
  useListDeals, getListDealsQueryKey, useCreateDeal, useUpdateDeal, useDeleteDeal,
  useListTasks, getListTasksQueryKey, useCreateTask, useUpdateTask, useDeleteTask,
  useGetCurrentMember, getGetCurrentMemberQueryKey, useListMembers, getListMembersQueryKey,
  useListJoinRequests, getListJoinRequestsQueryKey, useApproveJoinRequest, useRejectJoinRequest, useCreateInvitation,
  useListConversations, getListConversationsQueryKey, useCreateConversation,
  useListMessages, getListMessagesQueryKey, useCreateMessage,
  useListCommunityPosts, getListCommunityPostsQueryKey, useCreateCommunityPost, useCreateCommunityComment,
} from '../../../lib/api-client-react/src/generated/api';
import NotFound from '@/pages/not-found';

const client = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      void client.invalidateQueries({ queryKey: getGetDashboardActivityQueryKey() });
    },
  }),
  defaultOptions: { queries: { staleTime: 20_000, retry: 1, refetchOnWindowFocus: false } },
});
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
declare global {
  interface Window {
    Clerk?: any;
  }
}

type AnyRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// Authentication & Access Control (Clerk Sync + Super Admin Password Portal)
// ---------------------------------------------------------------------------
type AuthState = {
  isLoaded: boolean;
  member: AnyRecord | null;
  clerkKey: string;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string, initiationCode?: string) => Promise<void>;
  signOut: () => Promise<void>;
  superAdminLogin: (password: string, email?: string) => Promise<void>;
  requestAccess: (message: string) => Promise<void>;
  superAdminModalOpen: boolean;
  setSuperAdminModalOpen: (open: boolean) => void;
};
const AuthContext = createContext<AuthState | null>(null);
function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
async function authRequest(path: string, body: AnyRecord) {
  const res = await fetch(`/api/auth/${path}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Something went wrong. Please try again.');
  }
}
function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoaded, setLoaded] = useState(false);
  const [member, setMember] = useState<AnyRecord | null>(null);
  const [superAdminModalOpen, setSuperAdminModalOpen] = useState(false);
  const [clerkKey, setClerkKey] = useState<string>(() => {
    const envKey = (
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ||
      import.meta.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
      import.meta.env.CLERK_PUBLISHABLE_KEY ||
      ''
    ).trim();
    return envKey.startsWith('pk_') && !envKey.includes('your_publishable_key') ? envKey : '';
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/team/me', { credentials: 'include' });
      setMember(res.ok ? await res.json() : null);
    } catch { setMember(null); }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    // Also fetch runtime auth config in case key is loaded via server .env
    fetch('/api/auth/config')
      .then(res => res.json())
      .then(data => {
        if (data?.publishableKey && String(data.publishableKey).startsWith('pk_') && !String(data.publishableKey).includes('your_publishable_key')) {
          setClerkKey(data.publishableKey);
        }
      })
      .catch(() => { });
  }, [refresh]);

  const value: AuthState = {
    isLoaded, member, clerkKey, refresh,
    superAdminModalOpen, setSuperAdminModalOpen,
    signIn: async (email, password) => { await authRequest('sign-in', { email, password }); client.clear(); await refresh(); },
    signUp: async (name, email, password, initiationCode) => { await authRequest('sign-up', { name, email, password, initiationCode }); client.clear(); await refresh(); },
    superAdminLogin: async (password, email) => {
      await authRequest('super-admin-login', { password, email });
      client.clear();
      await refresh();
    },
    requestAccess: async (message) => {
      await authRequest('request-access', { message });
      await refresh();
    },
    signOut: async () => {
      // 1. Invalidate backend session cookie first so no race can restore the session
      try {
        await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
      } catch { }

      // 2. Clear query client cache, local/session storage, and member state
      try {
        client.clear();
        localStorage.clear();
        sessionStorage.clear();
      } catch { }
      setMember(null);

      // 3. Prepare sign-in redirect URL
      const targetUrl = `${window.location.origin}${basePath}/sign-in`;

      // 4. Sign out from Clerk with explicit redirect to /sign-in
      try {
        if (window.Clerk && typeof window.Clerk.signOut === 'function') {
          await window.Clerk.signOut({ redirectUrl: targetUrl });
          return;
        }
      } catch { }

      // 5. Fallback navigation if Clerk is not used or did not redirect
      window.location.replace(`${basePath}/sign-in`);
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function ClerkSyncBridge() {
  const { refresh, isLoaded: appLoaded } = useAuth();
  const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
  const lastSyncedId = useRef<string | null>(null);

  useEffect(() => {
    if (clerkLoaded && isSignedIn && user) {
      const email = user.primaryEmailAddress?.emailAddress;
      if (email && lastSyncedId.current !== user.id) {
        lastSyncedId.current = user.id;
        void fetch('/api/auth/clerk-sync', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            name: user.fullName || user.firstName || email.split('@')[0],
            clerkId: user.id,
            avatarUrl: user.imageUrl,
          }),
        }).then(async () => {
          client.clear();
          await refresh();
        }).catch(() => { });
      }
    } else if (clerkLoaded && !isSignedIn) {
      lastSyncedId.current = null;
    }
  }, [clerkLoaded, isSignedIn, user, refresh]);

  return null;
}

function SuperAdminModal() {
  const { superAdminModalOpen, setSuperAdminModalOpen, superAdminLogin } = useAuth();
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('superadmin@speedmatch.com');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!superAdminModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await superAdminLogin(password, email);
      setSuperAdminModalOpen(false);
      setPassword('');
      setLocation('/super-admin');
    } catch (err: any) {
      setError(err?.message || 'Invalid Super Admin password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Super Admin Portal Access" onClose={() => setSuperAdminModalOpen(false)} width="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4 p-6">
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-amber-900">
          <KeyRound className="h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-[12px] leading-relaxed">
            <strong>Super Admin Portal:</strong> Enter the master access password to manage workspace admins, approve user requests, and assign system permissions.
          </div>
        </div>
        {error && (
          <div role="alert" className="rounded-lg border border-[#f0d0ca] bg-[#fff3f0] p-3 text-[12px] text-[#98473d]">
            {error}
          </div>
        )}
        <label className="block text-[12px] font-semibold text-[#44534f]">
          Super Admin Email
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2 text-[13px] text-[#2c3834] outline-none focus:border-[#28785b]"
            required
          />
        </label>
        <label className="block text-[12px] font-semibold text-[#44534f]">
          Master Access Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter super admin master password"
            className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2 text-[13px] text-[#2c3834] outline-none focus:border-[#28785b]"
            required
            autoFocus
          />
        </label>
        <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-3">
          <Btn kind="outline" onClick={() => setSuperAdminModalOpen(false)}>Cancel</Btn>
          <Btn type="submit" disabled={busy} className="bg-amber-700 hover:bg-amber-800 text-white">
            <LockKeyhole size={14} /> {busy ? 'Verifying…' : 'Unlock Super Admin'}
          </Btn>
        </div>
      </form>
    </Dialog>
  );
}

function UnauthorizedGate({ member }: { member: AnyRecord }) {
  const { refresh, signOut, requestAccess, setSuperAdminModalOpen } = useAuth();
  const [customMsg, setCustomMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Notice>(null);
  const [checking, setChecking] = useState(false);

  // Auto-poll approval status every 3 seconds so the moment Super Admin approves, dashboard opens!
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/team/me', { credentials: 'include' });
        if (res.ok) {
          const m = await res.json();
          if (m?.status === 'active') {
            await refresh();
            window.location.reload();
          }
        }
      } catch { }
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customMsg.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await requestAccess(customMsg.trim());
      setFeedback({
        tone: 'good',
        text: 'Your custom message was sent to the Super Admin! You will gain dashboard access as soon as your account is approved.',
      });
      setCustomMsg('');
      await refresh();
    } catch (err: any) {
      setFeedback({ tone: 'bad', text: err?.message || 'Could not send message. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const [loggingOut, setLoggingOut] = useState(false);

  const handleSignOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    await signOut();
  };

  const handleCheckStatus = async () => {
    setChecking(true);
    setFeedback(null);
    try {
      // Re-sync with Clerk if user is signed in
      if (window.Clerk?.user) {
        const u = window.Clerk.user;
        const email = u.primaryEmailAddress?.emailAddress;
        if (email) {
          const syncRes = await fetch('/api/auth/clerk-sync', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email,
              name: u.fullName || u.firstName || email.split('@')[0],
              clerkId: u.id,
              avatarUrl: u.imageUrl,
            }),
          });
          if (syncRes.ok) {
            const data = await syncRes.json();
            if (data?.status === 'active' || data?.ok) {
              setFeedback({ tone: 'good', text: 'Approval confirmed! Launching your workspace…' });
              await refresh();
              setTimeout(() => window.location.reload(), 400);
              return;
            }
          }
        }
      }
      await refresh();
      const res = await fetch('/api/team/me', { credentials: 'include' });
      if (res.ok) {
        const m = await res.json();
        if (m?.status === 'active') {
          setFeedback({ tone: 'good', text: 'Approval confirmed! Launching your workspace…' });
          setTimeout(() => window.location.reload(), 400);
          return;
        }
      }
      setFeedback({ tone: 'info', text: 'Checked: Your account is still awaiting Super Admin approval.' });
    } catch {
      setFeedback({ tone: 'bad', text: 'Could not connect to verify status. Please retry in a moment.' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[radial-gradient(ellipse_at_top,#e6f3eb,transparent_65%),#f6f8f7] px-4 py-12">
      <div className="w-[520px] max-w-full rounded-2xl border border-[#dfe7e2] bg-white p-7 shadow-xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#fff2ec] text-[#d95a32]">
          <ShieldAlert size={26} />
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full bg-[#fff2ec] px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[#d95a32]">
          Authorization Required
        </div>
        <h1 className="mt-3 font-display text-[22px] font-extrabold tracking-tight text-[#253530]">
          To log in to this platform, notify Super Admin
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[#687672]">
          Self-creation of dashboards is restricted on SpeedMatch CRM. Only users assigned by the Super Admin (as Admin) or by an Admin (as Employee) can access workspace features.
        </p>

        <div className="mt-4 rounded-xl border border-[#e4ebe7] bg-[#f8faf9] p-3.5 text-[12px] text-[#4d5d58]">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[#273733]">Signed-in Account:</span>
            <span className="font-mono text-[11px] text-[#697873]">{member?.email}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[#697873]">Access Status:</span>
            <Badge tone="amber">Pending Approval</Badge>
          </div>
        </div>

        {feedback && (
          <div className={`mt-4 rounded-lg border px-3.5 py-2.5 text-[12px] ${feedback.tone === 'good' ? 'border-[#cae6d5] bg-[#edf8f1] text-[#28684b]' : feedback.tone === 'info' ? 'border-[#d0e0eb] bg-[#f0f6fa] text-[#24587a]' : 'border-[#f0d0ca] bg-[#fff3f0] text-[#98473d]'}`}>
            {feedback.text}
          </div>
        )}

        {member?.requestMessage ? (
          <div className="mt-4 rounded-xl border border-[#d6e7dc] bg-[#f2f8f4] p-4 text-[12px] text-[#2c5841]">
            <p className="font-bold text-[#1f4a33]">Your message to the Super Admin:</p>
            <p className="mt-1 italic">“{member.requestMessage}”</p>
            <p className="mt-2 text-[11px] text-[#48745c]">
              The Super Admin can see this message in their panel and assign your permissions.
            </p>
          </div>
        ) : null}

        <form onSubmit={handleSend} className="mt-5 space-y-3">
          <label className="block text-[12px] font-bold text-[#32433e]">
            {member?.requestMessage ? 'Send an updated message to Super Admin' : 'Send a custom message to Super Admin'}
            <textarea
              required
              rows={3}
              value={customMsg}
              onChange={e => setCustomMsg(e.target.value)}
              placeholder="E.g., Hi Super Admin, please approve my workspace access as Admin."
              className="mt-1.5 w-full resize-y rounded-xl border border-[#d8e3dd] bg-[#fcfdfc] p-3 text-[13px] text-[#2e3e39] outline-none focus:border-[#28785b] focus:ring-2 focus:ring-[#28785b]/10"
            />
          </label>
          <Btn type="submit" disabled={submitting || !customMsg.trim()} className="w-full">
            <Send size={14} /> {submitting ? 'Sending…' : 'Send Message to Super Admin'}
          </Btn>
        </form>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-[#edf1ef] pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Btn kind="outline" onClick={handleCheckStatus} disabled={checking}>
              <RotateCw size={13} className={checking ? 'animate-spin' : ''} /> {checking ? 'Checking…' : 'Check Approval Status'}
            </Btn>
            <Btn kind="ghost" onClick={() => setSuperAdminModalOpen(true)} className="text-[#3b6f56]">
              <ShieldCheck size={13} /> Super Admin Portal
            </Btn>
          </div>
          <Btn kind="ghost" onClick={handleSignOut} disabled={loggingOut} className="text-[#a84d41] hover:bg-[#fff2f0]">
            <LogOut size={13} className={loggingOut ? 'animate-spin' : ''} /> {loggingOut ? 'Signing out…' : 'Sign Out'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
type Field = { key: string; label: string; type?: string; options?: string[]; required?: boolean; placeholder?: string };
type Notice = { tone: 'good' | 'bad' | 'info'; text: string } | null;

const navGroups = [
  {
    label: 'Workspace', items: [
      { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Contacts', href: '/contacts', icon: ContactRound },
      { label: 'Companies', href: '/companies', icon: Building2 },
      { label: 'Deals', href: '/deals', icon: BriefcaseBusiness },
      { label: 'Tasks', href: '/tasks', icon: ListTodo },
      { label: 'Notes', href: '/notes', icon: NotebookPen },
    ]
  },
  {
    label: 'Connect', items: [
      { label: 'Inbox', href: '/inbox', icon: Inbox },
      { label: 'Community', href: '/community', icon: Compass },
      { label: 'Support & Feedback', href: '/support', icon: HelpCircle },
    ]
  },
  { label: 'Manage', items: [{ label: 'Team', href: '/team', icon: Users }] },
];
const pageNames: Record<string, string> = Object.fromEntries(navGroups.flatMap(g => g.items.map(i => [i.href, i.label])));
function exportToCsv(data: AnyRecord[], filename: string) {
  if (!data || !data.length) return;
  const sample = data[0];
  const keys = Object.keys(sample).filter(k => typeof sample[k] !== 'object' || sample[k] === null);
  const headerRow = keys.map(k => `"${k}"`).join(',');
  const rows = data.map(row => {
    return keys.map(k => {
      const v = row[k] ?? '';
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',');
  });
  const csvContent = 'data:text/csv;charset=utf-8,' + encodeURIComponent([headerRow, ...rows].join('\n'));
  const link = document.createElement('a');
  link.setAttribute('href', csvContent);
  link.setAttribute('download', `${filename}-${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

const fields: Record<string, Field[]> = {
  contacts: [
    { key: 'name', label: 'Full name', required: true }, { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'company', label: 'Company' }, { key: 'role', label: 'Role' }, { key: 'status', label: 'Relationship', options: ['Lead', 'Customer', 'Partner', 'Prospect'] },
    { key: 'source', label: 'Source' }, { key: 'owner', label: 'Owner' }, { key: 'phone', label: 'Phone' }, { key: 'notes', label: 'Notes', type: 'textarea' },
  ],
  companies: [
    { key: 'name', label: 'Company name', required: true },
    { key: 'adminEmail', label: 'Workspace Admin Email', type: 'email', placeholder: 'admin@company.com' },
    { key: 'adminName', label: 'Admin Full Name', placeholder: 'e.g. Jane Doe' },
    { key: 'industry', label: 'Industry' }, { key: 'website', label: 'Website' },
    { key: 'size', label: 'Team size', options: ['1–10', '11–50', '51–200', '201–500', '500+'] },
    { key: 'status', label: 'Status', options: ['Prospect', 'Customer', 'Partner', 'Inactive'] }, { key: 'owner', label: 'Owner' },
  ],
  deals: [
    { key: 'name', label: 'Deal name', required: true },
    { key: 'stage', label: 'Stage', options: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'] },
    { key: 'company', label: 'Company' }, { key: 'contact', label: 'Primary contact' },
    { key: 'owner', label: 'Owner' }, { key: 'expectedClose', label: 'Expected close', type: 'date' },
    { key: 'probability', label: 'Win probability (%)', type: 'number', placeholder: 'e.g. 60' },
  ],
  tasks: [
    { key: 'title', label: 'Task title', required: true },
    { key: 'type', label: 'Type', options: ['Call', 'Email', 'Meeting', 'Demo', 'Follow-up', 'Other'] },
    { key: 'dueDate', label: 'Due date', type: 'date' },
    { key: 'status', label: 'Status', options: ['Open', 'In progress', 'Completed'] },
    { key: 'priority', label: 'Priority', options: ['Urgent', 'High', 'Medium', 'Low'] },
    { key: 'owner', label: 'Owner' }, { key: 'contact', label: 'Related contact' },
  ],
};

function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${light ? 'text-white' : 'text-slate-800'}`}>
      <img src={`${basePath}/logo.png`} className="h-8 w-8 rounded-xl object-contain shadow-sm" alt="SpeedMatch" />
      <span className="font-display text-[16px] font-extrabold tracking-[-.04em]">
        speed<span className="text-[#f26422]">match</span>
        <span className="ml-1.5 rounded bg-[#f26422]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#f26422]">CRM</span>
      </span>
    </span>
  );
}
function Btn({ children, onClick, kind = 'primary', disabled = false, className = '', type = 'button', title }: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'soft' | 'outline' | 'ghost' | 'danger'; disabled?: boolean; className?: string; type?: 'button' | 'submit'; title?: string }) {
  const style = { primary: 'bg-[#28785b] text-white hover:bg-[#21664d] shadow-sm', soft: 'bg-[#eaf4ef] text-[#28785b] hover:bg-[#dfefe7]', outline: 'border border-[#dbe4e0] bg-white text-[#3e4c4d] hover:bg-[#f5f8f6]', ghost: 'text-[#657474] hover:bg-[#eff3f1]', danger: 'bg-[#fff0ed] text-[#ad493f] hover:bg-[#ffe5df]' }[kind];
  return <button data-testid="button-action" type={type} onClick={onClick} disabled={disabled} title={title} className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition duration-150 disabled:cursor-not-allowed disabled:opacity-55 ${style} ${className}`}>{children}</button>;
}
function IconBtn({ icon: Icon, onClick, title }: { icon: any; onClick: () => void; title: string }) {
  return <button data-testid={`button-${title.toLowerCase().replaceAll(' ', '-')}`} onClick={onClick} title={title} className="rounded-md p-1.5 text-[#75827f] transition hover:bg-[#eef3f0] hover:text-[#28785b]"><Icon size={15} /></button>;
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  const colors: Record<string, string> = { green: 'bg-[#eaf4ef] text-[#28785b]', amber: 'bg-[#fff5df] text-[#967124]', red: 'bg-[#fff0ed] text-[#ad493f]', blue: 'bg-[#eaf2f6] text-[#4f7589]', neutral: 'bg-[#f0f3f2] text-[#64716f]', purple: 'bg-[#f1eef8] text-[#746594]' };
  return <span className={`inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold leading-none ${colors[tone] ?? colors.neutral}`}>{children || '—'}</span>;
}
function Avatar({ name, size = 'md' }: { name?: string; size?: 'sm' | 'md' | 'lg' }) {
  const palette = ['bg-[#e9f2ed] text-[#347657]', 'bg-[#f4eee3] text-[#916e32]', 'bg-[#eaf0f5] text-[#4d708b]', 'bg-[#f1eaf0] text-[#855f7a]'];
  const initials = (name || 'SM').trim().split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
  const sizes = { sm: 'h-7 w-7 text-[10px]', md: 'h-9 w-9 text-[11px]', lg: 'h-11 w-11 text-[13px]' };
  return <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${sizes[size]} ${palette[(name || '').charCodeAt(0) % palette.length]}`}>{initials}</span>;
}
function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <header className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className="mb-1.5 text-[11px] font-bold uppercase tracking-[.14em] text-[#87938f]">SpeedMatch / {title}</div><h1 className="font-display text-[27px] font-bold tracking-[-.045em] text-[#26343a]">{title}</h1><p className="mt-1 text-[13px] text-[#74817e]">{description}</p></div>{action}</header>;
}
function LoadingRows() { return <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map(i => <div key={i} className="flex animate-pulse gap-4"><div className="h-8 w-8 rounded-full bg-[#edf1ef]" /><div className="flex-1 space-y-2"><div className="h-3 w-1/3 rounded bg-[#edf1ef]" /><div className="h-2.5 w-1/2 rounded bg-[#f2f4f3]" /></div></div>)}</div>; }
function NoticeBar({ notice, clear }: { notice: Notice; clear: () => void }) {
  if (!notice) return null;
  const color = notice.tone === 'good' ? 'border-[#cae6d5] bg-[#edf8f1] text-[#28684b]' : notice.tone === 'bad' ? 'border-[#f0d0ca] bg-[#fff3f0] text-[#98473d]' : 'border-[#cbdfe5] bg-[#eef7f9] text-[#436c78]';
  return <div role="status" data-testid="status-feedback" className={`mb-4 flex items-center justify-between rounded-lg border px-3.5 py-2.5 text-[13px] ${color}`}>{notice.text}<button data-testid="button-dismiss-notice" onClick={clear}><X size={15} /></button></div>;
}
function Empty({ title, detail, button }: { title: string; detail: string; button?: ReactNode }) {
  return <div className="flex min-h-52 flex-col items-center justify-center px-6 py-12 text-center"><span className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#edf4f0] text-[#428263]"><Sparkles size={19} /></span><h3 className="text-[14px] font-bold text-[#31413f]">{title}</h3><p className="mt-1 max-w-sm text-[12px] leading-5 text-[#7b8985]">{detail}</p>{button && <div className="mt-4">{button}</div>}</div>;
}
function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return <section onClick={onClick} className={`overflow-hidden rounded-xl border border-[#e2e9e5] bg-white shadow-[0_2px_9px_rgba(30,56,45,.025)] ${className}`}>{children}</section>;
}
function CardTitle({ title, detail, right }: { title: string; detail?: string; right?: ReactNode }) {
  return <div className="flex items-center justify-between border-b border-[#edf0ee] px-5 py-4"><div><h2 className="text-[13px] font-bold text-[#31403e]">{title}</h2>{detail && <p className="mt-1 text-[11px] text-[#899490]">{detail}</p>}</div>{right}</div>;
}
function Dialog({ title, onClose, children, width = 'max-w-xl' }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#15231f]/35 px-4 py-6 backdrop-blur-[2px]" onMouseDown={e => { if (e.currentTarget === e.target) onClose(); }}><div role="dialog" aria-modal="true" className={`fade-in max-h-[90vh] w-full ${width} overflow-y-auto rounded-2xl border border-[#e1e9e4] bg-white shadow-[0_24px_80px_rgba(23,49,39,.2)]`}><div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#edf0ee] bg-white px-5 py-4"><h2 className="font-display text-[17px] font-bold tracking-tight">{title}</h2><IconBtn icon={X} onClick={onClose} title="Close" /></div>{children}</div></div>;
}
function FieldInput({ field, value, set }: { field: Field; value: any; set: (value: any) => void }) {
  const base = 'mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2.5 text-[13px] text-[#344340] outline-none transition focus:border-[#70a88c] focus:ring-2 focus:ring-[#28785b]/10';
  return <label className="block text-[12px] font-semibold text-[#52605d]">{field.label}{field.required && <span className="ml-1 text-[#bc5c4e]">*</span>}
    {field.options ? <select required={field.required} value={value ?? ''} onChange={e => set(e.target.value)} className={base}><option value="">Select {field.label.toLowerCase()}</option>{field.options.map(v => <option key={v} value={v}>{v}</option>)}</select> :
      field.type === 'textarea' ? <textarea required={field.required} value={value ?? ''} onChange={e => set(e.target.value)} rows={3} className={`${base} resize-y`} placeholder={field.placeholder ?? `Add ${field.label.toLowerCase()}`} /> :
        field.type === 'date' ? <input required={field.required} type="date" value={value ? String(value).slice(0, 10) : ''} onChange={e => set(e.target.value)} className={base} /> :
          <input required={field.required} type={field.type ?? 'text'} min={field.type === 'number' ? 0 : undefined} max={field.key === 'probability' ? 100 : undefined} value={value ?? ''} onChange={e => set(field.type === 'number' ? e.target.value : e.target.value)} className={base} placeholder={field.placeholder ?? `Enter ${field.label.toLowerCase()}`} />}
  </label>;
}
function RecordDialog({ entity, initial, onClose, onSave, busy }: { entity: string; initial?: AnyRecord; onClose: () => void; onSave: (data: AnyRecord) => void; busy: boolean }) {
  const entityFields = fields[entity];
  const [form, setForm] = useState<AnyRecord>(() => {
    const raw: AnyRecord = {};
    for (const f of entityFields) {
      let val = initial?.[f.key] ?? '';
      if (f.type === 'date' && val) val = String(val).slice(0, 10);
      raw[f.key] = val;
    }
    return raw;
  });
  const title = `${initial ? 'Edit' : 'Add'} ${entity === 'contacts' ? 'contact' : entity === 'companies' ? 'company' : entity.slice(0, -1)}`;
  return <Dialog title={title} onClose={onClose}>
    <form className="space-y-4 p-5" onSubmit={e => {
      e.preventDefault();
      const data: AnyRecord = { ...form };
      for (const f of entityFields) {
        if (f.type === 'number' && data[f.key] !== '') data[f.key] = Number(data[f.key]);
        if (!data[f.key]) delete data[f.key];
      }
      onSave(data);
    }}>
      {entity === 'companies' && (
        <div className="rounded-lg border border-[#d6e7dc] bg-[#f2f8f4] px-3.5 py-2.5 text-[12px] text-[#2c5841]">
          When you assign a Workspace Admin Email, that person is immediately granted Admin access. As soon as they sign in with Clerk using that email, their dashboard will unlock immediately.
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {entityFields.map(field => (
          <div key={field.key} className={field.type === 'textarea' ? 'sm:col-span-2' : ''}>
            <FieldInput field={field} value={form[field.key]} set={value => setForm(old => ({ ...old, [field.key]: value }))} />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-4">
        <Btn kind="outline" onClick={onClose}>Cancel</Btn>
        <Btn type="submit" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Create record'}</Btn>
      </div>
    </form>
  </Dialog>;
}

function Landing() {
  const { member, isLoaded, setSuperAdminModalOpen } = useAuth();
  if (isLoaded && member) return <Redirect to={member.role === 'super_admin' ? '/super-admin' : '/dashboard'} />;
  return <main className="min-h-[100dvh] overflow-hidden bg-[#f8faf8] text-[#24332f]">
    <nav className="mx-auto flex max-w-[1240px] items-center justify-between px-6 py-6">
      <Link href="/" aria-label="SpeedMatch home" className="transition hover:opacity-90">
        <Logo />
      </Link>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setSuperAdminModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/90 bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-900 shadow-sm transition hover:bg-amber-100"
        >
          <KeyRound size={13} className="text-amber-700" /> Super Admin
        </button>
        <Link href="/sign-in" data-testid="link-sign-in" className="rounded-lg bg-[#28785b] px-5 py-2.5 text-[13px] font-semibold text-white shadow-sm hover:bg-[#21664d]">
          Sign in <ArrowRight size={14} className="ml-1 inline" />
        </Link>
      </div>
    </nav>

    <section className="relative mx-auto grid max-w-[1240px] items-center gap-14 px-6 pb-20 pt-16 lg:grid-cols-[1.08fr_.92fr] lg:pb-28 lg:pt-24">
      <div className="absolute -right-32 top-10 h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle,rgba(242,100,34,.12),transparent_68%)]" />
      <div className="relative z-10 fade-in">
        <div className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-[#d8e7dc] bg-white px-3.5 py-1.5 text-[12px] font-bold text-[#23583f] shadow-sm">
          <img src={`${basePath}/logo.png`} className="h-4 w-4 rounded-md object-contain" alt="" />
          <span>SpeedMatch CRM — Relationship & Pipeline Engine</span>
        </div>
        <h1 className="font-display max-w-[670px] text-[48px] font-extrabold leading-[1.06] tracking-[-.065em] text-[#25342f] sm:text-[66px]">
          Good connections<br />move startups <span className="text-[#f26422]">forward.</span>
        </h1>
        <p className="mt-6 max-w-[490px] text-[16px] leading-7 text-[#697873]">
          Keep customers, deals, follow-ups, and your startup community close. SpeedMatch gives a small team one calm place to keep momentum.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/sign-in" data-testid="link-get-started" className="inline-flex items-center gap-2 rounded-lg bg-[#28785b] px-6 py-3.5 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(40,120,91,.18)] transition hover:-translate-y-0.5 hover:bg-[#21664d]">
            Sign in to Workspace <ArrowRight size={16} />
          </Link>
        </div>
        <div className="mt-11 flex items-center gap-4 border-t border-[#e5ebe7] pt-5">
          <div className="flex -space-x-2">
            <Avatar name="Maya Chen" size="sm" />
            <Avatar name="Owen Brooks" size="sm" />
            <Avatar name="Lena Ortiz" size="sm" />
          </div>
          <p className="text-[12px] text-[#74817d]">
            <strong className="text-[#3b4a45]">Built for the people doing the work.</strong><br />Small teams. Real relationships. Less busywork.
          </p>
        </div>
      </div>

      <div className="relative z-10 fade-in lg:translate-y-3">
        <div className="absolute -inset-5 rounded-[28px] bg-[#e5efe8] blur-2xl" />
        <div className="relative rounded-[20px] border border-[#e3eae5] bg-white p-4 shadow-[0_24px_70px_rgba(40,70,54,.12)] sm:p-5">
          <div className="mb-4 flex items-center justify-between border-b border-[#f0f3f1] pb-3">
            <div className="flex items-center gap-2.5">
              <img src={`${basePath}/logo.png`} className="h-7 w-7 rounded-lg object-contain shadow-sm" alt="" />
              <div>
                <p className="text-[12px] font-extrabold tracking-tight text-[#23352f]">SpeedMatch CRM</p>
                <p className="text-[10px] text-[#85928d]">Workspace Hub</p>
              </div>
            </div>
            <span className="text-[10px] font-semibold tracking-wide text-[#85928d]">LIVE PIPELINE</span>
          </div>
          <div className="rounded-xl bg-[#f7faf8] p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#83918b]">Active relationships</p>
                <p className="mt-1 font-display text-[30px] font-extrabold tracking-[-.055em]">184 partners</p>
              </div>
              <span className="rounded-md bg-[#e8f4ec] px-2 py-1 text-[10px] font-bold text-[#347653]">+18.4%</span>
            </div>
            <div className="mt-4 flex h-[90px] items-end gap-2 border-b border-[#e6ece8] pb-1">
              {[30, 45, 36, 57, 48, 67, 59, 83, 72, 92, 76, 100, 87, 94].map((v, i) => (
                <span key={i} className="flex-1 rounded-t-sm bg-[#9ac7a8]" style={{ height: `${v}%`, opacity: .45 + (i / 30) }} />
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[9px] text-[#98a29d]">
              <span>Mar 01</span><span>Mar 15</span><span>Apr 01</span><span>Apr 15</span><span>May 01</span>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-[#edf0ee] p-3.5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-[#76837e]">Next up</span>
                <CalendarDays size={13} className="text-[#83918b]" />
              </div>
              <div className="flex items-center gap-2">
                <span className="h-7 w-1 rounded-full bg-[#f26422]" />
                <div>
                  <p className="text-[11px] font-bold">Pricing follow-up</p>
                  <p className="mt-0.5 text-[9px] text-[#89938f]">Avery at Northstar · 2:30 PM</p>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-[#edf0ee] p-3.5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-[#76837e]">Recent activity</span>
                <ActivityIcon size={13} className="text-[#83918b]" />
              </div>
              <div className="flex items-center gap-2">
                <Avatar name="Avery Mason" size="sm" />
                <div>
                  <p className="text-[11px] font-bold">New conversation</p>
                  <p className="mt-0.5 text-[9px] text-[#89938f]">Avery · 12 minutes ago</p>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl bg-[#1e2c38] px-4 py-3 text-white">
            <div className="flex items-center gap-2.5">
              <img src={`${basePath}/logo.png`} className="h-5 w-5 rounded-md object-contain" alt="" />
              <span className="text-[11px] font-semibold">Good teams stay in sync.</span>
            </div>
            <span className="text-[10px] text-[#83b4cf]">Your team, one view</span>
          </div>
        </div>
      </div>
    </section>

    <section className="border-y border-[#e6ebe7] bg-white/65">
      <div className="mx-auto grid max-w-[1240px] gap-8 px-6 py-9 md:grid-cols-3">
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#eaf4ee] text-[#347b57]">
            <ContactRound size={17} />
          </span>
          <div>
            <p className="text-[13px] font-bold">Relationships, remembered</p>
            <p className="mt-1 text-[12px] leading-5 text-[#798681]">Know the person, company, and context behind every opportunity.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#fff1ec] text-[#d95a32]">
            <Target size={17} />
          </span>
          <div>
            <p className="text-[13px] font-bold">Momentum, made visible</p>
            <p className="mt-1 text-[12px] leading-5 text-[#798681]">A focused pipeline and timely follow-ups without the CRM overhead.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#edf0f7] text-[#687a9b]">
            <MessageCircle size={17} />
          </span>
          <div>
            <p className="text-[13px] font-bold">Your community, together</p>
            <p className="mt-1 text-[12px] leading-5 text-[#798681]">Share a win, find an answer, and keep conversations close to work.</p>
          </div>
        </div>
      </div>
    </section>

    <footer className="mx-auto flex max-w-[1240px] items-center justify-between px-6 py-8 text-[11px] text-[#8a9691]">
      <Logo />
      <span>Clear relationships make stronger startups.</span>
    </footer>
  </main>;
}

function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const { signIn, signUp, member, isLoaded } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [initiationCode, setInitiationCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const up = mode === 'sign-up';
  if (isLoaded && member) return <Redirect to={member.role === 'super_admin' ? '/super-admin' : '/dashboard'} />;
  const input = 'mt-1.5 w-full rounded-lg border border-[#dce4e0] bg-[#f8faf9] px-3 py-2.5 text-[14px] text-[#26343a] outline-none focus:border-[#70a88c] focus:ring-2 focus:ring-[#28785b]/10';
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    try { if (up) await signUp(name, email, password, initiationCode); else await signIn(email, password); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }
  return <div className="w-[440px] max-w-full rounded-2xl bg-white p-8 shadow-xl">
    <h1 className="font-display text-[22px] font-bold text-[#26343a]">Sign in to Workspace</h1>
    <p className="mt-1 text-[13px] text-[#68777b]">Enter your email and password to access your team dashboard.</p>
    {error && <div role="alert" className="mt-4 rounded-lg border border-[#f0d0ca] bg-[#fff3f0] px-3.5 py-2.5 text-[13px] text-[#98473d]">{error}</div>}
    <label className="mt-4 block text-[13px] font-medium text-[#26343a]">Email<input data-testid="input-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} className={input} autoComplete="email" /></label>
    <label className="mt-4 block text-[13px] font-medium text-[#26343a]">Password<input data-testid="input-password" type="password" required value={password} onChange={e => setPassword(e.target.value)} className={input} autoComplete="current-password" /></label>
    <button data-testid="button-submit-auth" type="submit" disabled={busy} className="mt-6 w-full rounded-lg bg-[#28785b] px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#21674d] disabled:opacity-60">{busy ? 'Please wait…' : 'Sign in'}</button>
  </div>;
}

function SignInPage() {
  const { isLoaded, member, clerkKey, setSuperAdminModalOpen } = useAuth();
  if (isLoaded && member) return <Redirect to={member.role === 'super_admin' ? '/super-admin' : '/dashboard'} />;

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-[radial-gradient(ellipse_at_top,#e5f1e8,transparent_62%),#f5f8f6] px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2">
        <Link href="/" aria-label="SpeedMatch home"><Logo /></Link>
      </div>
      {clerkKey ? (
        <div className="flex flex-col items-center">
          <ClerkSignIn routing="path" path={`${basePath}/sign-in`} />
          <div className="mt-5 text-center">
            <button
              type="button"
              onClick={() => setSuperAdminModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-[13px] font-bold text-amber-900 shadow-sm transition hover:bg-amber-100"
            >
              <KeyRound size={14} className="text-amber-700" /> Super Admin Password Access
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <button
            type="button"
            onClick={() => setSuperAdminModalOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] font-bold text-amber-900 shadow-sm transition hover:bg-amber-100"
          >
            <KeyRound size={14} className="text-amber-700" /> Super Admin Portal Access (Password)
          </button>
          <AuthForm mode="sign-in" />
        </div>
      )}
    </div>
  );
}

function SignUpPage() {
  return <Redirect to="/sign-in" />;
}

function AppShell({ path, member, children }: { path: string; member: AnyRecord; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { signOut } = useAuth();
  const [, setLocation] = useLocation();
  const name = member?.name || member?.email || 'Team member';
  const isSuperAdmin = member?.role === 'super_admin';
  const isAdmin = member?.role === 'admin' || member?.role === 'owner' || isSuperAdmin;
  const effectiveNavGroups = isSuperAdmin ? [
    {
      label: 'Super Admin',
      items: [
        { label: 'Workspaces & Access', href: '/super-admin', icon: ShieldCheck },
        { label: 'Companies', href: '/companies', icon: Building2 },
        { label: 'Tasks', href: '/tasks', icon: ListTodo },
        { label: 'Notes', href: '/notes', icon: NotebookPen },
        { label: 'Community', href: '/community', icon: Compass },
        { label: 'Support & Reports', href: '/support', icon: HelpCircle },
      ],
    },
  ] : navGroups.map(group => ({
    ...group,
    items: group.items.filter(item => {
      if (item.href === '/companies' && !isAdmin) return false;
      return true;
    }),
  }));

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const [loggingOut, setLoggingOut] = useState(false);
  const handleSignOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    await signOut();
  };

  return <div className="min-h-[100dvh] bg-[#f6f8f7]">
    {mobileOpen && <button aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-30 bg-[#15231f]/30 md:hidden" />}
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-[236px] flex-col bg-[#263934] text-[#d8e4dd] transition-transform duration-200 md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex h-[68px] items-center border-b border-white/10 px-5"><Logo light /></div>
      <div className="mx-3 mt-5 flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[.055] px-3 py-2.5"><span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#bddac6] text-[#28513c]"><BriefcaseBusiness size={14} /></span><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-bold text-white">{isSuperAdmin ? 'Super Admin Mode' : 'My workspace'}</p><p className="truncate text-[10px] text-[#a8b9af]">{isSuperAdmin ? 'Platform Management' : 'Startup team'}</p></div><ChevronDown size={13} className="text-[#a8b9af]" /></div>
      <nav className="mt-5 flex-1 space-y-5 overflow-y-auto px-3">{effectiveNavGroups.map(group => <div key={group.label}><div className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[.17em] text-[#82968a]">{group.label}</div><div className="space-y-0.5">{group.items.map(({ label, href, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} data-testid={`nav-${label.toLowerCase()}`} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[12px] font-medium transition ${path === href ? 'bg-[#e8f2eb] text-[#263d33] shadow-sm' : 'text-[#c0cec5] hover:bg-white/[.075] hover:text-white'}`}><Icon size={16} strokeWidth={1.8} /><span className="flex-1">{label}</span>{label === 'Inbox' && <span className="h-1.5 w-1.5 rounded-full bg-[#84c99b]" />}</Link>)}</div></div>)}</nav>
      <div className="m-3 rounded-xl border border-white/10 bg-[#30443d] p-3.5"><div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#405c4e] text-[#b8d8c1]"><Sparkles size={14} /></span><span className="text-[11px] font-bold text-white">{isSuperAdmin ? 'Master Access' : 'Built for momentum'}</span></div><p className="mt-2 text-[10px] leading-4 text-[#b0c1b7]">{isSuperAdmin ? 'Super admin access control & workspace management.' : 'Keep the important conversations moving.'}</p></div>
      <div className="border-t border-white/10 p-3"><button data-testid="button-account-menu" disabled={loggingOut} onClick={handleSignOut} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-white/[.06] disabled:opacity-60"><Avatar name={name} size="sm" /><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold text-white">{name}</span><span className="block truncate text-[10px] capitalize text-[#9eb0a5]">{loggingOut ? 'Signing out…' : `${member?.role || 'Member'} · Sign out`}</span></span><LogOut size={14} className={`text-[#aabbb0] ${loggingOut ? 'animate-spin' : ''}`} /></button></div>
    </aside>
    <div className="min-h-[100dvh] md:pl-[236px]">
      <div className="sticky top-0 z-20 flex h-[58px] items-center justify-between border-b border-[#e3e9e5] bg-[#f9fbfa]/95 px-4 backdrop-blur md:px-7"><div className="flex items-center gap-3"><button aria-label="Open navigation" data-testid="button-open-navigation" onClick={() => setMobileOpen(true)} className="rounded-lg p-2 text-[#667671] hover:bg-[#edf2ef] md:hidden"><Menu size={18} /></button><div className="hidden items-center gap-2 text-[11px] text-[#89948f] sm:flex"><span>{isSuperAdmin ? 'Super Admin' : 'Workspace'}</span><ChevronRight size={13} /><span className="font-semibold text-[#46554f]">{path === '/super-admin' ? 'Workspaces & Access' : (pageNames[path] || (isSuperAdmin ? 'Super Admin' : 'Dashboard'))}</span></div>{!isSuperAdmin && <div className="relative hidden lg:block">
        <input ref={searchInputRef} aria-label="Jump to a page" data-testid="input-global-search" placeholder="Jump to a page…" onKeyDown={e => { if (e.key === 'Enter') { const query = e.currentTarget.value.toLowerCase(); const target = effectiveNavGroups.flatMap(g => g.items).find(item => item.label.toLowerCase().includes(query)); if (target) setLocation(target.href); } }} className="ml-6 w-[215px] rounded-lg border border-[#e3e9e5] bg-white py-1.5 pl-8 pr-12 text-[11px] outline-none placeholder:text-[#9ba6a1] focus:border-[#a3c9b2]" /><kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-[#e8ece9] px-1 text-[9px] text-[#9aa49f]">⌘ K</kbd></div>}</div><div className="flex items-center gap-3"><span className="hidden items-center gap-1.5 rounded-full bg-[#eaf4ed] px-2.5 py-1 text-[10px] font-semibold text-[#347553] sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-[#69a981]" /> {isSuperAdmin ? 'Super Admin Active' : 'Synced'}</span>{!isSuperAdmin && <div className="relative"><button aria-label="Notifications" data-testid="status-notifications" onClick={() => setNotificationsOpen(v => !v)} className="relative rounded-lg p-2 text-[#76837e] transition hover:bg-[#edf2ef] hover:text-[#28785b]"><Bell size={17} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#38855e]" /></button>{notificationsOpen && <div className="absolute right-0 top-12 z-50 w-72 rounded-xl border border-[#e1e8e4] bg-white p-3 shadow-xl"><div className="mb-2 flex items-center justify-between border-b border-[#edf0ee] pb-2"><span className="text-[12px] font-bold text-[#32423c]">Notifications</span><span className="text-[10px] text-[#71817b]">Workspace live</span></div><div className="space-y-2 text-[11px]"><div className="rounded-lg bg-[#f6f9f7] p-2 text-[#465650]"><p className="font-semibold text-[#28785b]">Active Workspace Sync</p><p className="text-[10px] text-[#7b8984]">All contacts, deals, and tasks are synchronized.</p></div><Link href="/tasks" onClick={() => setNotificationsOpen(false)} className="block rounded-lg p-2 hover:bg-[#f3f7f5] text-[#34443e]"><p className="font-semibold">Review your follow-ups</p><p className="text-[10px] text-[#818f8a]">Check today’s task queue to maintain momentum.</p></Link></div></div>}</div>}<span className="hidden h-6 w-px bg-[#e1e7e3] sm:block" /><Avatar name={name} size="sm" /></div></div>
      <main className="mx-auto max-w-[1480px] px-4 py-6 md:px-7 md:py-7">{children}</main>
    </div>
  </div>;
}


function Metric({ label, value, note, icon: Icon, onClick }: { label: string; value: string; note: string; icon: any; change?: string; onClick?: () => void }) {
  return <Card className={`p-4 transition ${onClick ? 'cursor-pointer hover:border-[#a0c5b0] hover:shadow-sm' : ''}`} onClick={onClick}><div className="flex items-start justify-between"><span className="text-[11px] font-semibold text-[#77847f]">{label}</span><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#edf5f0] text-[#43815f]"><Icon size={16} /></span></div><div className="mt-2 flex items-baseline gap-2"><strong className="font-display text-[25px] font-extrabold tracking-[-.055em] text-[#293a34]">{value}</strong></div><p className="mt-1 text-[10px] text-[#939d99]">{note}</p></Card>;
}
function currency(value: any) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value) || 0); }
function dateLabel(value: any) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date); }
function ToneStatus({ value }: { value: any }) {
  const v = String(value || '—');
  const tone = /won|customer|approved|complete|active/i.test(v) ? 'green' : /negotiation|pending|progress|qualified|proposal/i.test(v) ? 'amber' : /lost|rejected|overdue|inactive/i.test(v) ? 'red' : /lead|discovery/i.test(v) ? 'blue' : 'neutral';
  return <Badge tone={tone}>{v}</Badge>;
}
function Table({ headers, children, min = 'min-w-[740px]' }: { headers: string[]; children: ReactNode; min?: string }) {
  return <div className="overflow-x-auto"><table className={`w-full ${min} text-left`}><thead><tr className="border-b border-[#edf0ee] bg-[#fafbfa]">{headers.map(h => <th key={h} className="px-4 py-3 text-[9px] font-bold uppercase tracking-[.1em] text-[#8a9691] first:pl-5 last:pr-5">{h}</th>)}</tr></thead><tbody className="divide-y divide-[#f0f2f1]">{children}</tbody></table></div>;
}

function PostCommentInput({ postId, onComment, isPending }: { postId: number; onComment: (id: number, text: string) => void; isPending: boolean }) {
  const [text, setText] = useState('');
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={e => {
        e.preventDefault();
        const body = text.trim();
        if (!body) return;
        onComment(postId, body);
        setText('');
      }}
    >
      <input
        data-testid={`input-comment-${postId}`}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Add a thoughtful reply…"
        className="min-w-0 flex-1 rounded-lg border border-[#e4eae6] bg-[#fafbfa] px-3 py-2 text-[11px] outline-none focus:border-[#9fc5ac]"
      />
      <Btn type="submit" kind="soft" disabled={!text.trim() || isPending}>
        <Send size={13} /> Reply
      </Btn>
    </form>
  );
}

function Workspace({ path, member }: { path: string; member: AnyRecord }) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<Notice>(null);
  const [search, setSearch] = useState('');
  const [filteredOnly, setFilteredOnly] = useState(false);
  const [modal, setModal] = useState<{ entity: string; row?: AnyRecord } | null>(null);
  const [activeConversation, setActiveConversation] = useState<number | null>(null);
  const [messageBody, setMessageBody] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [postOpen, setPostOpen] = useState(false);
  const [postForm, setPostForm] = useState({ title: '', body: '', category: 'Founder question' });
  const [conversationOpen, setConversationOpen] = useState(false);
  const [conversationForm, setConversationForm] = useState({ name: '', type: 'direct', memberIds: '' });
  const [selectedMemberIds, setSelectedMemberIds] = useState<number[]>([]);
  const [inboxTab, setInboxTab] = useState<'chats' | 'teammates'>('chats');
  const [feedback, setFeedback] = useState<Notice>(null);
  const [taskTab, setTaskTab] = useState<'all' | 'remaining' | 'completed'>('all');
  const [dealView, setDealView] = useState<'kanban' | 'list'>('kanban');
  const approved = String(member?.status || '').toLowerCase() === 'active';
  const isAdmin = String(member?.role || '').toLowerCase() === 'admin' || String(member?.role || '').toLowerCase() === 'owner';
  const queryOpts = <T extends unknown>(key: T, enabled = true, refetchInterval?: number) => ({ query: { enabled: approved && enabled, queryKey: key as any, refetchInterval } });

  const dash = useGetDashboardSummary(queryOpts(getGetDashboardSummaryQueryKey(), path === '/dashboard', 30_000));
  const activity = useGetDashboardActivity(queryOpts(getGetDashboardActivityQueryKey(), path === '/dashboard', 30_000));
  const analytics = useGetAnalytics(queryOpts(getGetAnalyticsQueryKey(), path === '/dashboard', 30_000));
  const contacts = useListContacts(undefined, queryOpts(getListContactsQueryKey(), path === '/contacts' || path === '/dashboard', 10_000));
  const companies = useListCompanies(undefined, queryOpts(getListCompaniesQueryKey(), (path === '/companies' || path === '/dashboard') && isAdmin, 10_000));
  const deals = useListDeals(undefined, queryOpts(getListDealsQueryKey(), path === '/deals' || path === '/dashboard', 10_000));
  const tasks = useListTasks(undefined, queryOpts(getListTasksQueryKey(), path === '/tasks' || path === '/dashboard', 10_000));
  const members = useListMembers(queryOpts(getListMembersQueryKey(), path === '/team' || path === '/inbox' || path === '/dashboard', 10_000));
  const requests = useListJoinRequests({ query: { enabled: approved && isAdmin && path === '/team', queryKey: getListJoinRequestsQueryKey() } });
  const conversations = useListConversations(queryOpts(getListConversationsQueryKey(), path === '/inbox', 10_000));
  const posts = useListCommunityPosts(queryOpts(getListCommunityPostsQueryKey(), path === '/community', 30_000));
  const messages = useListMessages(activeConversation as number, { query: { enabled: approved && path === '/inbox' && !!activeConversation, queryKey: getListMessagesQueryKey(activeConversation as number), refetchInterval: 5_000 } });

  const createContact = useCreateContact(); const updateContact = useUpdateContact(); const deleteContact = useDeleteContact();
  const createCompany = useCreateCompany(); const updateCompany = useUpdateCompany(); const deleteCompany = useDeleteCompany();
  const createDeal = useCreateDeal(); const updateDeal = useUpdateDeal(); const deleteDeal = useDeleteDeal();
  const createTask = useCreateTask(); const updateTask = useUpdateTask(); const deleteTask = useDeleteTask();
  const approveRequest = useApproveJoinRequest(); const rejectRequest = useRejectJoinRequest(); const createInvitation = useCreateInvitation();
  const createConversation = useCreateConversation(); const createMessage = useCreateMessage();
  const createPost = useCreateCommunityPost(); const createComment = useCreateCommunityComment();
  const allPending = [createContact, updateContact, deleteContact, createCompany, updateCompany, deleteCompany, createDeal, updateDeal, deleteDeal, createTask, updateTask, deleteTask, approveRequest, rejectRequest, createInvitation, createConversation, createMessage, createPost, createComment].some(x => x.isPending);

  function invalidate(key: readonly unknown[], text: string, entity?: string) {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardActivityQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAnalyticsQueryKey() });
    setNotice({ tone: 'good', text });
    setModal(null);
  }
  const nextStageMap: Record<string, string> = {
    Lead: 'Qualified',
    Qualified: 'Proposal',
    Proposal: 'Negotiation',
    Negotiation: 'Won',
  };
  function moveDealStage(deal: AnyRecord, nextStage: string) {
    updateDeal.mutate(
      { id: deal.id, data: { stage: nextStage } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListDealsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          qc.invalidateQueries({ queryKey: getGetAnalyticsQueryKey() });
          setNotice({ tone: 'good', text: `Deal "${deal.name}" moved to ${nextStage}.` });
        },
        onError: () => setNotice({ tone: 'bad', text: 'Could not update deal stage.' }),
      }
    );
  }
  const resourceData: Record<string, any> = { contacts: contacts.data, companies: companies.data, deals: deals.data, tasks: tasks.data };
  const resourceQuery: Record<string, any> = { contacts, companies, deals, tasks };
  const keys: Record<string, readonly unknown[]> = { contacts: getListContactsQueryKey(), companies: getListCompaniesQueryKey(), deals: getListDealsQueryKey(), tasks: getListTasksQueryKey() };
  function saveResource(entity: string, data: AnyRecord) {
    const initial = modal?.row;
    const done = (name: string) => invalidate(keys[entity], `${name} ${initial ? 'updated' : 'created'} successfully.`, entity);
    if (entity === 'contacts') {
      if (initial) updateContact.mutate({ id: initial.id, data }, { onSuccess: () => done('Contact'), onError: () => setNotice({ tone: 'bad', text: 'Contact could not be saved. Check the fields and try again.' }) });
      else createContact.mutate({ data: data as any }, { onSuccess: () => done('Contact'), onError: () => setNotice({ tone: 'bad', text: 'Contact could not be created. Try again.' }) });
    } else if (entity === 'companies') {
      const onDone = () => {
        done('Company');
        qc.invalidateQueries({ queryKey: getListMembersQueryKey() });
      };
      if (initial) updateCompany.mutate({ id: initial.id, data }, { onSuccess: onDone, onError: () => setNotice({ tone: 'bad', text: 'Company could not be saved. Try again.' }) });
      else createCompany.mutate({ data: data as any }, { onSuccess: onDone, onError: () => setNotice({ tone: 'bad', text: 'Company could not be created. Try again.' }) });
    } else if (entity === 'deals') {
      const dealData = { ...data, value: Number(data.value || 0), probability: data.probability !== undefined && data.probability !== '' ? Number(data.probability) : 10 };
      if (initial) updateDeal.mutate({ id: initial.id, data: dealData }, { onSuccess: () => done('Deal'), onError: () => setNotice({ tone: 'bad', text: 'Deal could not be saved. Try again.' }) });
      else createDeal.mutate({ data: dealData as any }, { onSuccess: () => done('Deal'), onError: () => setNotice({ tone: 'bad', text: 'Deal could not be created. Try again.' }) });
    } else {
      if (initial) updateTask.mutate({ id: initial.id, data }, { onSuccess: () => done('Task'), onError: () => setNotice({ tone: 'bad', text: 'Task could not be saved. Try again.' }) });
      else createTask.mutate({ data: data as any }, { onSuccess: () => done('Task'), onError: () => setNotice({ tone: 'bad', text: 'Task could not be created. Try again.' }) });
    }
  }
  function removeResource(entity: string, row: AnyRecord) {
    if (!window.confirm(`Delete "${row.name || row.title}"? This cannot be undone.`)) return;
    const onSuccess = () => { qc.invalidateQueries({ queryKey: keys[entity] }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardActivityQueryKey() }); qc.invalidateQueries({ queryKey: getGetAnalyticsQueryKey() }); setNotice({ tone: 'good', text: 'Record deleted.' }); };
    const onError = () => setNotice({ tone: 'bad', text: 'Record could not be deleted. Please try again.' });
    if (entity === 'contacts') deleteContact.mutate({ id: row.id }, { onSuccess, onError });
    if (entity === 'companies') deleteCompany.mutate({ id: row.id }, { onSuccess, onError });
    if (entity === 'deals') deleteDeal.mutate({ id: row.id }, { onSuccess, onError });
    if (entity === 'tasks') deleteTask.mutate({ id: row.id }, { onSuccess, onError });
  }
  const clearFeedback = () => { setNotice(null); setFeedback(null); };
  const notices = <><NoticeBar notice={notice || feedback} clear={clearFeedback} /></>;

  if (member?.status && !approved) {
    const rejected = String(member.status).toLowerCase() === 'rejected';
    return <div className="grid min-h-[100dvh] place-items-center bg-[#f5f8f6] p-5"><Card className="max-w-lg p-8 text-center"><div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl ${rejected ? 'bg-[#fff0ed] text-[#b94d41]' : 'bg-[#edf4ef] text-[#327653]'}`}>{rejected ? <LockKeyhole size={21} /> : <Clock3 size={21} />}</div><h1 className="font-display text-xl font-bold">{rejected ? 'Access request not approved' : 'Your request is in review'}</h1><p className="mt-2 text-[13px] leading-6 text-[#74817d]">{rejected ? 'Your workspace administrator did not approve this request. Contact your team if you think this is a mistake.' : 'You are signed in, but your workspace membership still needs approval. We’ll let you in as soon as your team reviews the request.'}</p><div className="mt-6 flex justify-center gap-2"><Btn kind="outline" onClick={() => window.location.reload()}><RotateCw size={14} /> Check again</Btn></div></Card></div>;
  }
  const qs: any = path === '/dashboard' ? [dash, activity] : path === '/contacts' ? [contacts] : path === '/companies' ? [companies] : path === '/deals' ? [deals] : path === '/tasks' ? [tasks] : path === '/inbox' ? [conversations, ...(activeConversation ? [messages] : [])] : path === '/community' ? [posts] : path === '/team' ? [members, ...(isAdmin ? [requests] : [])] : [];
  const failed = qs.find((q: any) => q.isError);

  const resourceTitle: Record<string, { title: string; description: string; singular: string }> = {
    contacts: { title: 'Contacts', description: 'People behind the partnerships, customers, and opportunities.', singular: 'contact' },
    companies: { title: 'Companies', description: 'Keep every organization and relationship in one clear view.', singular: 'company' },
    deals: { title: 'Deals', description: 'A focused view of the opportunities moving your business forward.', singular: 'deal' },
    tasks: { title: 'Tasks', description: 'Follow-ups and next steps, right where your relationships live.', singular: 'task' },
  };
  function ResourcePage({ entity }: { entity: string }) {
    const rows: AnyRecord[] = resourceData[entity] || [];
    const query = resourceQuery[entity];
    const q = search.trim().toLowerCase();
    const remainingTasksCount = entity === 'tasks' ? rows.filter(r => !/complete/i.test(String(r.status || ''))).length : 0;
    const completedTasksCount = entity === 'tasks' ? rows.filter(r => /complete/i.test(String(r.status || ''))).length : 0;
    const filtered = rows.filter(r => {
      if (q && !Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q))) return false;
      if (entity === 'tasks') {
        if (taskTab === 'remaining') return !/complete/i.test(String(r.status || ''));
        if (taskTab === 'completed') return /complete/i.test(String(r.status || ''));
      }
      if (filteredOnly && /complete|won|lost|inactive/i.test(String(r.status || ''))) return false;
      return true;
    });
    const meta = resourceTitle[entity];
    const stageOptions = entity === 'deals' ? ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'] : entity === 'tasks' ? ['Open', 'In progress', 'Completed'] : [];

    const dealColumns = [
      { stage: 'Lead', border: 'border-blue-200', bg: 'bg-blue-50/40', badge: 'bg-blue-100 text-blue-800' },
      { stage: 'Qualified', border: 'border-indigo-200', bg: 'bg-indigo-50/40', badge: 'bg-indigo-100 text-indigo-800' },
      { stage: 'Proposal', border: 'border-amber-200', bg: 'bg-amber-50/40', badge: 'bg-amber-100 text-amber-800' },
      { stage: 'Negotiation', border: 'border-orange-200', bg: 'bg-orange-50/40', badge: 'bg-orange-100 text-orange-800' },
      { stage: 'Won', border: 'border-emerald-200', bg: 'bg-emerald-50/40', badge: 'bg-emerald-100 text-emerald-800' },
      { stage: 'Lost', border: 'border-rose-200', bg: 'bg-rose-50/40', badge: 'bg-rose-100 text-rose-800' },
    ];

    return (
      <>
        <PageHeader
          title={meta.title}
          description={meta.description}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Btn kind="outline" onClick={() => exportToCsv(filtered, entity)} title={`Export ${meta.title} to CSV`}>
                <Download size={13} /> Export CSV
              </Btn>
              <Btn onClick={() => setModal({ entity })}>
                <Plus size={15} /> Add {meta.singular}
              </Btn>
            </div>
          }
        />
        {notices}
        <Card>
          {entity === 'tasks' && (
            <div className="flex flex-wrap items-center gap-2 border-b border-[#edf0ee] bg-[#fbfcfb] px-4 py-2.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#798882]">Filter Tasks:</span>
              <button
                type="button"
                onClick={() => setTaskTab('all')}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${taskTab === 'all' ? 'bg-[#28785b] text-white shadow-sm' : 'border border-[#dbe4df] bg-white text-[#495953] hover:bg-[#edf4f0]'}`}
              >
                All Tasks ({rows.length})
              </button>
              <button
                type="button"
                onClick={() => setTaskTab('remaining')}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${taskTab === 'remaining' ? 'bg-[#28785b] text-white shadow-sm' : 'border border-[#dbe4df] bg-white text-[#495953] hover:bg-[#edf4f0]'}`}
              >
                Remaining Tasks ({remainingTasksCount})
              </button>
              <button
                type="button"
                onClick={() => setTaskTab('completed')}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${taskTab === 'completed' ? 'bg-[#28785b] text-white shadow-sm' : 'border border-[#dbe4df] bg-white text-[#495953] hover:bg-[#edf4f0]'}`}
              >
                Completed ({completedTasksCount})
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#edf0ee] px-4 py-3">
            <div className="relative min-w-[220px] flex-1 sm:max-w-[360px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#97a29d]" />
              <input
                data-testid={`input-search-${entity}`}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={`Search ${entity}…`}
                className="w-full rounded-lg border border-[#e5ebe7] bg-[#fbfcfb] py-2 pl-9 pr-3 text-[12px] outline-none focus:border-[#9fc5ac]"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {entity === 'deals' && (
                <div className="flex items-center rounded-lg border border-[#dce5e0] bg-[#f2f6f4] p-0.5">
                  <button
                    type="button"
                    onClick={() => setDealView('kanban')}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${dealView === 'kanban' ? 'bg-white text-[#28785b] shadow-sm' : 'text-[#64746e] hover:text-[#28785b]'}`}
                  >
                    <Kanban size={13} /> Board
                  </button>
                  <button
                    type="button"
                    onClick={() => setDealView('list')}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${dealView === 'list' ? 'bg-white text-[#28785b] shadow-sm' : 'text-[#64746e] hover:text-[#28785b]'}`}
                  >
                    <List size={13} /> Table
                  </button>
                </div>
              )}
              <Badge>{filtered.length} records</Badge>
              <Btn kind={filteredOnly ? 'soft' : 'ghost'} onClick={() => setFilteredOnly(v => !v)} className="px-2.5">
                <Filter size={14} /> {filteredOnly ? 'Active only' : 'Filter active'}
              </Btn>
            </div>
          </div>
          {query.isLoading ? (
            <LoadingRows />
          ) : query.isError ? (
            <Empty
              title="Couldn’t load records"
              detail="The data service is unavailable right now. Retry when your connection is ready."
              button={<Btn kind="outline" onClick={() => query.refetch()}><RotateCw size={14} /> Retry</Btn>}
            />
          ) : filtered.length === 0 ? (
            <Empty
              title={q ? 'No matching records' : `No ${entity} yet`}
              detail={q ? 'Try a different name or search term.' : `Add your first ${meta.singular} and start building a useful picture of your relationships.`}
              button={!q && <Btn onClick={() => setModal({ entity })}><Plus size={14} /> Add {meta.singular}</Btn>}
            />
          ) : entity === 'deals' && dealView === 'kanban' ? (
            <div className="overflow-x-auto p-4 bg-[#f8faf9]">
              <div className="flex gap-4 min-w-[1200px] items-start">
                {dealColumns.map(col => {
                  const colDeals = filtered.filter(d => (d.stage || 'Lead') === col.stage);
                  return (
                    <div key={col.stage} className={`flex-1 rounded-xl border ${col.border} ${col.bg} p-3 flex flex-col min-w-[240px] max-w-[300px]`}>
                      <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-black/5">
                        <div className="flex items-center gap-1.5">
                          <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold ${col.badge}`}>{col.stage}</span>
                          <span className="text-[11px] font-semibold text-[#6a7a74]">({colDeals.length})</span>
                        </div>
                        <span className="text-[11px] font-semibold text-[#5a6b65]">{colDeals.length} {colDeals.length === 1 ? 'deal' : 'deals'}</span>
                      </div>
                      <div className="space-y-2.5 flex-1 min-h-[140px]">
                        {colDeals.length === 0 ? (
                          <div className="h-28 rounded-lg border border-dashed border-[#d2dcd6] flex flex-col items-center justify-center text-center p-3 text-[11px] text-[#8e9c96]">
                            <span>No deals in this stage</span>
                            <button
                              type="button"
                              onClick={() => setModal({ entity: 'deals', row: { stage: col.stage } })}
                              className="mt-1 text-[10px] font-semibold text-[#28785b] hover:underline"
                            >
                              + Add to {col.stage}
                            </button>
                          </div>
                        ) : (
                          colDeals.map(deal => (
                            <div key={deal.id} className="rounded-lg border border-[#e1e8e4] bg-white p-3 shadow-sm hover:border-[#9ec4af] hover:shadow transition group">
                              <div className="flex items-start justify-between gap-1">
                                <button
                                  type="button"
                                  onClick={() => setModal({ entity: 'deals', row: deal })}
                                  className="text-left font-semibold text-[12px] text-[#2c3a35] hover:text-[#28785b] line-clamp-1"
                                  title={deal.name}
                                >
                                  {deal.name}
                                </button>
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
                                  <IconBtn icon={Pencil} onClick={() => setModal({ entity: 'deals', row: deal })} title="Edit" />
                                  <IconBtn icon={Trash2} onClick={() => removeResource('deals', deal)} title="Delete" />
                                </div>
                              </div>
                              <div className="mt-1.5 flex items-center justify-between">
                                <span className="text-[10px] font-semibold text-[#486358] bg-[#ecf4ef] px-2 py-0.5 rounded">
                                  {deal.stage || 'Lead'}
                                </span>
                                {deal.probability ? (
                                  <span className="text-[10px] font-semibold text-[#546b62] bg-[#f0f5f2] px-1.5 py-0.5 rounded">{deal.probability}% win</span>
                                ) : null}
                              </div>
                              {deal.company && (
                                <p className="mt-1 flex items-center gap-1 text-[11px] text-[#5b6a65] truncate">
                                  <Building2 size={12} className="shrink-0 text-[#8e9c97]" />
                                  <span className="truncate">{deal.company}</span>
                                </p>
                              )}
                              <div className="mt-2 flex items-center justify-between text-[10px] text-[#84928d] border-t border-[#f0f3f1] pt-2">
                                <span className="flex items-center gap-1 truncate">
                                  <Avatar name={deal.owner || 'U'} size="sm" />
                                  <span className="truncate">{deal.owner || 'Unassigned'}</span>
                                </span>
                                {deal.expectedClose && <span>{dateLabel(deal.expectedClose)}</span>}
                              </div>
                              <div className="mt-2.5 flex items-center justify-between gap-1 border-t border-[#f2f5f3] pt-2">
                                {nextStageMap[deal.stage] ? (
                                  <button
                                    type="button"
                                    onClick={() => moveDealStage(deal, nextStageMap[deal.stage])}
                                    className="flex items-center gap-1 rounded bg-[#eaf4ed] px-2 py-1 text-[10px] font-bold text-[#28785b] hover:bg-[#d9ece0] transition"
                                  >
                                    → {nextStageMap[deal.stage]}
                                  </button>
                                ) : (
                                  <span />
                                )}
                                <div className="flex items-center gap-1">
                                  {deal.stage !== 'Won' && (
                                    <button
                                      type="button"
                                      onClick={() => moveDealStage(deal, 'Won')}
                                      className="rounded bg-emerald-50 px-1.5 py-1 text-[9px] font-bold text-emerald-700 hover:bg-emerald-100 transition"
                                      title="Mark Won"
                                    >
                                      Won
                                    </button>
                                  )}
                                  {deal.stage !== 'Lost' && (
                                    <button
                                      type="button"
                                      onClick={() => moveDealStage(deal, 'Lost')}
                                      className="rounded bg-rose-50 px-1.5 py-1 text-[9px] font-bold text-rose-700 hover:bg-rose-100 transition"
                                      title="Mark Lost"
                                    >
                                      Lost
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setModal({ entity: 'deals', row: { stage: col.stage } })}
                        className="mt-2.5 flex items-center justify-center gap-1 rounded-lg border border-transparent py-1.5 text-[11px] font-semibold text-[#54655f] hover:border-[#ccd7d1] hover:bg-white/80 transition"
                      >
                        <Plus size={12} /> Add Deal
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <Table
              headers={
                entity === 'contacts'
                  ? ['Name', 'Company', 'Relationship', 'Owner', 'Added', '']
                  : entity === 'companies'
                    ? ['Company', 'Industry', 'Team size', 'Status', 'Owner', '']
                    : entity === 'deals'
                      ? ['Opportunity', 'Company', 'Stage', 'Win probability', 'Close date', 'Owner', '']
                      : ['Follow-up', 'Type', 'Due date', 'Priority', 'Status', 'Owner', '']
              }
            >
              {filtered.map(r => (
                <tr key={r.id} data-testid={`row-${entity}-${r.id}`} className="group transition hover:bg-[#fafcfb]">
                  {entity === 'contacts' && (
                    <>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={r.name} size="sm" />
                          <div>
                            <p className="text-[12px] font-semibold text-[#33413d]">{r.name}</p>
                            <p className="mt-0.5 text-[10px] text-[#84908c]">{r.email || r.role || '—'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-[#52605b]">{r.company || '—'}</td>
                      <td className="px-4 py-3"><ToneStatus value={r.status} /></td>
                      <td className="px-4 py-3 text-[11px] text-[#67746f]">{r.owner || '—'}</td>
                      <td className="px-4 py-3 text-[11px] text-[#87918d]">{dateLabel(r.createdAt)}</td>
                    </>
                  )}
                  {entity === 'companies' && (
                    <>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#f0f3f1] text-[#62716b]">
                            <Building2 size={15} />
                          </span>
                          <div>
                            <p className="text-[12px] font-semibold text-[#33413d]">{r.name}</p>
                            <p className="mt-0.5 text-[10px] text-[#84908c]">{r.website || 'No website'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-[#52605b]">{r.industry || '—'}</td>
                      <td className="px-4 py-3 text-[12px] text-[#52605b]">{r.size || '—'}</td>
                      <td className="px-4 py-3"><ToneStatus value={r.status} /></td>
                      <td className="px-4 py-3 text-[11px] text-[#67746f]">{r.owner || '—'}</td>
                    </>
                  )}
                  {entity === 'deals' && (
                    <>
                      <td className="px-5 py-3">
                        <p className="text-[12px] font-semibold text-[#33413d]">{r.name}</p>
                        <p className="mt-0.5 text-[10px] text-[#84908c]">{r.contact || 'No contact'}</p>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-[#52605b]">{r.company || '—'}</td>
                      <td className="px-4 py-3">
                        <select
                          aria-label={`Change ${r.name} stage`}
                          data-testid={`select-stage-${r.id}`}
                          value={r.stage || 'Lead'}
                          onChange={e => updateDeal.mutate({ id: r.id, data: { stage: e.target.value } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListDealsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); qc.invalidateQueries({ queryKey: getGetAnalyticsQueryKey() }); setNotice({ tone: 'good', text: 'Deal stage updated.' }); }, onError: () => setNotice({ tone: 'bad', text: 'Could not update deal stage.' }) })}
                          className="rounded-md border border-[#dde4e0] bg-white px-2 py-1 text-[11px] font-medium text-[#384842] outline-none"
                        >
                          {stageOptions.map(x => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-[#52605b]">{r.probability ? `${r.probability}%` : '—'}</td>
                      <td className="px-4 py-3 text-[11px] text-[#87918d]">{dateLabel(r.expectedClose)}</td>
                      <td className="px-4 py-3 text-[11px] text-[#67746f]">{r.owner || '—'}</td>
                    </>
                  )}
                  {entity === 'tasks' && (
                    <>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            title={/complete/i.test(r.status || '') ? 'Mark as Open' : 'Mark as Completed'}
                            onClick={() => {
                              const nextStatus = /complete/i.test(r.status || '') ? 'Open' : 'Completed';
                              updateTask.mutate({ id: r.id, data: { status: nextStatus } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListTasksQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); setNotice({ tone: 'good', text: `Task "${r.title}" marked as ${nextStatus}.` }); }, onError: () => setNotice({ tone: 'bad', text: 'Could not update task.' }) });
                            }}
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition ${/complete/i.test(r.status || '') ? 'border-[#30815f] bg-[#eaf4ef] text-[#28785b]' : 'border-[#d4dfd8] bg-white text-transparent hover:border-[#28785b] hover:text-[#28785b]/60'}`}
                          >
                            <Check size={13} strokeWidth={2.5} />
                          </button>
                          <div>
                            <p className={`text-[12px] font-semibold ${/complete/i.test(r.status) ? 'text-[#9aa49f] line-through' : 'text-[#33413d]'}`}>{r.title}</p>
                            <p className="mt-0.5 text-[10px] text-[#84908c]">{r.contact || 'No linked contact'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[11px] text-[#64716d]">{r.type || '—'}</td>
                      <td className="px-4 py-3 text-[11px] text-[#64716d]">{dateLabel(r.dueDate)}</td>
                      <td className="px-4 py-3">
                        <Badge tone={r.priority === 'Urgent' || r.priority === 'High' ? 'red' : r.priority === 'Medium' ? 'amber' : 'neutral'}>
                          {r.priority || 'Normal'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          aria-label={`Change ${r.title} status`}
                          data-testid={`select-task-status-${r.id}`}
                          value={r.status || 'Open'}
                          onChange={e => updateTask.mutate({ id: r.id, data: { status: e.target.value } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListTasksQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); setNotice({ tone: 'good', text: 'Task status updated.' }); }, onError: () => setNotice({ tone: 'bad', text: 'Could not update task status.' }) })}
                          className="rounded-md border border-[#e1e8e4] bg-[#fafbfa] px-2 py-1 text-[11px] font-medium text-[#384842] outline-none"
                        >
                          {['Open', 'In progress', 'Completed'].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-[11px] text-[#67746f]">{r.owner || '—'}</td>
                    </>
                  )}
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-1 opacity-60 transition group-hover:opacity-100">
                      <IconBtn icon={Pencil} onClick={() => setModal({ entity, row: r })} title="Edit record" />
                      <IconBtn icon={Trash2} onClick={() => removeResource(entity, r)} title="Delete record" />
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </>
    );
  }

  function Dashboard() {
    const d: any = dash.data;
    const an: any = analytics.data;
    const allActivities: AnyRecord[] = (activity.data as AnyRecord[]) || [];
    const a: AnyRecord[] = allActivities.filter(item => {
      if (item.kind === 'superadmin') return false;
      const title = String(item.title || '').toLowerCase();
      const detail = String(item.detail || '').toLowerCase();
      if (
        title.includes('workspace admin') ||
        title.includes('removed user') ||
        title.includes('company removed') ||
        title.includes('company added') ||
        title.includes('company deleted') ||
        title.includes('company updated') ||
        title.includes('initiation code') ||
        title.includes('admin password') ||
        title.includes('pre-assigned') ||
        title.includes('assigned user as admin') ||
        detail.includes('workspace admin')
      ) {
        return false;
      }
      return true;
    });

    const allTasksList = (tasks.data as AnyRecord[]) || [];
    const allDealsList = (deals.data as AnyRecord[]) || [];
    const remainingTasks = allTasksList.filter(t => !/complete/i.test(t.status || ''));
    const completedTasks = allTasksList.filter(t => /complete/i.test(t.status || ''));
    const todayStr = new Date().toISOString().slice(0, 10);
    const overdueTasks = remainingTasks.filter(t => t.dueDate && t.dueDate < todayStr);
    const topTasks = [...remainingTasks, ...completedTasks].slice(0, 6);

    const taskCompletionRate = allTasksList.length ? Math.round((completedTasks.length / allTasksList.length) * 100) : 100;
    const slaHealthPct = remainingTasks.length
      ? Math.max(0, Math.round(((remainingTasks.length - overdueTasks.length) / remainingTasks.length) * 100))
      : 100;
    const activeDealsCount = allDealsList.filter(dl => !/won|lost/i.test(dl.stage || '')).length;

    // Task breakdown by types
    const typeCounts: Record<string, { total: number; done: number }> = {};
    for (const t of allTasksList) {
      const type = t.type || 'Follow-up';
      if (!typeCounts[type]) typeCounts[type] = { total: 0, done: 0 };
      typeCounts[type].total++;
      if (/complete/i.test(t.status || '')) typeCounts[type].done++;
    }
    const taskTypesList = Object.entries(typeCounts).map(([type, stats]) => ({
      type,
      total: stats.total,
      done: stats.done,
      pct: Math.round((stats.done / Math.max(stats.total, 1)) * 100),
    })).sort((x, y) => y.total - x.total);

    // Stage Funnel (deals count only)
    const stageFunnel: Array<{ stage: string; count: number }> = (d?.stageBreakdown || an?.stageBreakdown || []).map((s: any) => ({
      stage: s.stage,
      count: s.count,
    }));
    const maxFunnelCount = Math.max(...stageFunnel.map(s => s.count), 1);

    // Team Leaderboard (deals & tasks assigned)
    const ownersList: Array<{ owner: string; count: number }> = (an?.ownerBreakdown || []).map((o: any) => ({
      owner: o.owner,
      count: o.count,
    }));
    const sortedOwners = [...ownersList].sort((x, y) => y.count - x.count);

    return (
      <>
        <PageHeader
          title={`Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, ${(member.name || '').split(' ')[0] || 'there'}`}
          description="Operational dashboard tracking opportunity execution, task resolution, and team follow-up SLA performance."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Btn kind="outline" onClick={() => exportToCsv(allDealsList, 'deals-pipeline')} title="Export deals CSV">
                <Download size={13} /> Export Deals
              </Btn>
              <Btn onClick={() => setModal({ entity: 'deals' })}>
                <Plus size={15} /> New deal
              </Btn>
            </div>
          }
        />
        {notices}

        {/* Quick Action Ribbon */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#e2e8e4] bg-white p-2.5 shadow-sm">
          <span className="px-2 text-[10px] font-bold uppercase tracking-wider text-[#798882]">Quick Actions:</span>
          <button
            type="button"
            onClick={() => setModal({ entity: 'deals' })}
            className="flex items-center gap-1.5 rounded-lg border border-[#dde5e0] bg-[#fbfcfb] px-3 py-1.5 text-[11px] font-semibold text-[#32433d] transition hover:bg-[#edf5f0] hover:text-[#28785b] hover:border-[#a5cbb5]"
          >
            <Plus size={13} className="text-[#28785b]" /> Deal
          </button>
          <button
            type="button"
            onClick={() => setModal({ entity: 'contacts' })}
            className="flex items-center gap-1.5 rounded-lg border border-[#dde5e0] bg-[#fbfcfb] px-3 py-1.5 text-[11px] font-semibold text-[#32433d] transition hover:bg-[#edf5f0] hover:text-[#28785b] hover:border-[#a5cbb5]"
          >
            <ContactRound size={13} className="text-[#3b7e5b]" /> Contact
          </button>
          <button
            type="button"
            onClick={() => setModal({ entity: 'tasks' })}
            className="flex items-center gap-1.5 rounded-lg border border-[#dde5e0] bg-[#fbfcfb] px-3 py-1.5 text-[11px] font-semibold text-[#32433d] transition hover:bg-[#edf5f0] hover:text-[#28785b] hover:border-[#a5cbb5]"
          >
            <CalendarDays size={13} className="text-[#967b36]" /> Follow-up
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setModal({ entity: 'companies' })}
              className="flex items-center gap-1.5 rounded-lg border border-[#dde5e0] bg-[#fbfcfb] px-3 py-1.5 text-[11px] font-semibold text-[#32433d] transition hover:bg-[#edf5f0] hover:text-[#28785b] hover:border-[#a5cbb5]"
            >
              <Building2 size={13} className="text-[#4b6a82]" /> Company
            </button>
          )}
          <div className="ml-auto hidden sm:flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setDealView('kanban'); setLocation('/deals'); }}
              className="flex items-center gap-1.5 rounded-lg bg-[#28785b]/10 px-3 py-1.5 text-[11px] font-bold text-[#28785b] transition hover:bg-[#28785b]/20"
            >
              <Kanban size={13} /> Pipeline Board →
            </button>
          </div>
        </div>

        {dash.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-white" />
            ))}
          </div>
        ) : dash.isError ? (
          <Card>
            <Empty
              title="Dashboard is taking a pause"
              detail="We couldn’t load your workspace summary."
              button={<Btn kind="outline" onClick={() => dash.refetch()}><RotateCw size={14} /> Retry</Btn>}
            />
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric
              label="Active Opportunities"
              value={String(activeDealsCount)}
              note={`${allDealsList.length} total in pipeline`}
              icon={Target}
              onClick={() => { setDealView('kanban'); setLocation('/deals'); }}
            />
            <Metric
              label="Task Completion Rate"
              value={`${taskCompletionRate}%`}
              note={`${completedTasks.length} of ${allTasksList.length} resolved`}
              icon={CheckCircle2}
              onClick={() => setLocation('/tasks')}
            />
            <Metric
              label="Follow-up SLA Health"
              value={`${slaHealthPct}%`}
              note={overdueTasks.length ? `${overdueTasks.length} overdue follow-ups` : 'All follow-ups on-track'}
              icon={ShieldCheck}
              onClick={() => setLocation('/tasks')}
            />
            <Metric
              label="Follow-ups Due"
              value={String(remainingTasks.length)}
              note={overdueTasks.length ? `${overdueTasks.length} overdue · ${remainingTasks.length} pending` : `${remainingTasks.length} tasks remaining`}
              icon={CalendarDays}
              onClick={() => setLocation('/tasks')}
            />
            <Metric
              label="Network Contacts"
              value={String((contacts.data as AnyRecord[] || []).length)}
              note={isAdmin ? `${(companies.data as AnyRecord[] || []).length} organizations mapped` : 'Active contacts'}
              icon={ContactRound}
              onClick={() => setLocation('/contacts')}
            />
          </div>
        )}

        {/* Funnel & Task Completion Charts */}
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <Card>
            <CardTitle
              title="Pipeline Stage Distribution"
              detail="Opportunity volume across active pipeline stages"
              right={
                <Link href="/deals" className="flex items-center gap-1 text-[11px] font-bold text-[#28785b] hover:underline">
                  Board <ArrowRight size={12} />
                </Link>
              }
            />
            {stageFunnel.length ? (
              <div className="space-y-3.5 p-5">
                {stageFunnel.map(s => {
                  const pct = Math.max(6, Math.min(100, (s.count / maxFunnelCount) * 100));
                  const sharePct = allDealsList.length ? Math.round((s.count / allDealsList.length) * 100) : 0;
                  return (
                    <div key={s.stage} className="rounded-lg border border-[#f0f3f1] bg-[#fafcfb] p-3">
                      <div className="mb-2 flex items-center justify-between text-[11px]">
                        <span className="font-bold text-[#32423c]">{s.stage}</span>
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-[#667671]">{s.count} {s.count === 1 ? 'deal' : 'deals'}</span>
                          <span className="font-semibold text-[#28785b]">{sharePct}% of pipeline</span>
                        </div>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-[#e8eee9]">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#32845f] to-[#4fa979] transition-all duration-500"
                          style={{ width: s.count > 0 ? `${pct}%` : '0%' }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty
                title="No active pipeline"
                detail="Create an opportunity to visualize momentum across stages."
                button={<Btn kind="soft" onClick={() => setModal({ entity: 'deals' })}><Plus size={13} /> Add a deal</Btn>}
              />
            )}
          </Card>

          <Card>
            <CardTitle
              title="Task Completion & Productivity Performance"
              detail="Follow-up resolution velocity, status distribution, and activity by type"
              right={
                <Link href="/tasks" className="flex items-center gap-1 text-[11px] font-bold text-[#28785b] hover:underline">
                  All Tasks <ArrowRight size={12} />
                </Link>
              }
            />
            <div className="p-5">
              {/* Overall Progress Bar */}
              <div className="rounded-xl border border-[#e5ebe7] bg-[#fbfcfb] p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-bold text-[#34443e]">Overall Resolution Rate</span>
                  <span className="text-[14px] font-extrabold text-[#28785b]">{taskCompletionRate}%</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-[#e8eee9] flex">
                  <div
                    className="h-full bg-[#28785b] transition-all duration-500"
                    style={{ width: `${taskCompletionRate}%` }}
                    title={`Completed: ${completedTasks.length}`}
                  />
                  <div
                    className="h-full bg-rose-400 transition-all duration-500"
                    style={{ width: `${allTasksList.length ? Math.round((overdueTasks.length / allTasksList.length) * 100) : 0}%` }}
                    title={`Overdue: ${overdueTasks.length}`}
                  />
                </div>
                <div className="mt-2.5 flex items-center justify-between text-[10px] text-[#788882]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#28785b]" /> {completedTasks.length} Completed
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#d0dad4]" /> {remainingTasks.length - overdueTasks.length} Open
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-rose-400" /> {overdueTasks.length} Overdue
                  </span>
                </div>
              </div>

              {/* Activity breakdown by Type */}
              <div className="mt-4">
                <p className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-[#798882]">Activity Performance by Type</p>
                {taskTypesList.length ? (
                  <div className="space-y-2.5">
                    {taskTypesList.slice(0, 4).map(item => (
                      <div key={item.type} className="rounded-lg border border-[#f0f3f1] bg-white p-2.5">
                        <div className="flex items-center justify-between text-[11px] mb-1.5">
                          <span className="font-semibold text-[#32423c]">{item.type}</span>
                          <span className="text-[10px] font-medium text-[#6c7d77]">
                            <strong className="text-[#28785b]">{item.done}</strong> of {item.total} completed ({item.pct}%)
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[#edf1ee]">
                          <div
                            className="h-full rounded-full bg-[#32845f] transition-all duration-500"
                            style={{ width: `${item.pct}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-[#84928d] italic py-2">Add follow-up tasks to graph activity completion by type.</p>
                )}
              </div>

              {/* Bottom SLA Summary */}
              <div className="mt-4 flex items-center justify-between border-t border-[#edf0ee] pt-3 text-[11px] text-[#788882]">
                <span>SLA Health: <strong className="text-[#28785b]">{slaHealthPct}%</strong> on-schedule</span>
                <span>Pending Queue: <strong className="text-[#32423c]">{remainingTasks.length}</strong> tasks</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Leaderboard and SLA Queue */}
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <Card>
            <CardTitle
              title="Team Opportunity & Pipeline Allocation"
              detail="Active opportunity assignments and pipeline distribution by team member"
              right={<Users size={15} className="text-[#788781]" />}
            />
            {sortedOwners.length ? (
              <div className="divide-y divide-[#f0f3f1]">
                {sortedOwners.map((owner, idx) => (
                  <div key={owner.owner} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-[#fafcfb]">
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${idx === 0 ? 'bg-amber-100 text-amber-800' : idx === 1 ? 'bg-slate-200 text-slate-700' : 'bg-[#eef2f0] text-[#63726d]'}`}>
                      #{idx + 1}
                    </span>
                    <Avatar name={owner.owner} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-bold text-[#34443e]">{owner.owner}</p>
                      <p className="text-[10px] text-[#80908a]">{owner.count} active {owner.count === 1 ? 'deal' : 'deals'}</p>
                    </div>
                    <span className="text-[12px] font-bold text-[#28785b]">{owner.count} assigned</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No rep assignments" detail="Assign deals to team members to track leaderboards here." />
            )}
          </Card>

          <Card>
            <CardTitle
              title="High-Priority Follow-up SLA Queue"
              detail={`${remainingTasks.length} pending · Prioritize overdue and urgent customer interactions`}
              right={<Link href="/tasks" className="text-[11px] font-semibold text-[#43815f]">All tasks ({allTasksList.length}) <ArrowRight size={12} className="inline" /></Link>}
            />
            {tasks.isLoading ? (
              <LoadingRows />
            ) : topTasks.length ? (
              <div className="divide-y divide-[#f0f2f1]">
                {topTasks.map(t => {
                  const isOverdue = !/complete/i.test(t.status || '') && t.dueDate && t.dueDate < todayStr;
                  const isDone = /complete/i.test(t.status || '');
                  return (
                    <div key={t.id} className="flex items-center gap-3 px-5 py-3 transition hover:bg-[#fafcfb]">
                      <button
                        type="button"
                        title={isDone ? 'Mark open' : 'Mark completed'}
                        onClick={() => updateTask.mutate({ id: t.id, data: { status: isDone ? 'Open' : 'Completed' } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListTasksQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); setNotice({ tone: 'good', text: `Task "${t.title}" updated.` }); }, onError: () => setNotice({ tone: 'bad', text: 'Could not update task.' }) })}
                        className={`flex h-7 w-7 items-center justify-center rounded-lg border transition ${isDone ? 'border-[#30815f] bg-[#eaf4ee] text-[#28785b]' : 'border-[#d4dfd8] bg-white text-transparent hover:border-[#28785b] hover:text-[#28785b]/60'}`}
                      >
                        <Check size={14} strokeWidth={2.5} />
                      </button>
                      <button onClick={() => setModal({ entity: 'tasks', row: t })} className="min-w-0 flex-1 text-left">
                        <div className="flex items-center gap-2">
                          <p className={`truncate text-[12px] font-semibold ${isDone ? 'text-[#9aa49f] line-through' : 'text-[#384742]'}`}>{t.title}</p>
                          {isOverdue && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-rose-800">Overdue</span>}
                        </div>
                        <p className="mt-0.5 text-[10px] text-[#84928d]">
                          {t.type || 'Follow-up'} {t.contact ? `· ${t.contact}` : ''} · Due {dateLabel(t.dueDate)}
                        </p>
                      </button>
                      <Badge tone={t.priority === 'Urgent' || t.priority === 'High' ? 'red' : t.priority === 'Medium' ? 'amber' : 'neutral'}>
                        {t.priority || 'Normal'}
                      </Badge>
                      <button onClick={() => setModal({ entity: 'tasks', row: t })}><ToneStatus value={t.status} /></button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty title="All caught up!" detail="Add a follow-up task so no deal drops off." button={<Btn kind="soft" onClick={() => setModal({ entity: 'tasks' })}><Plus size={13} /> Add task</Btn>} />
            )}
          </Card>
        </div>
      </>
    );
  }
  function Team() {
    const team: AnyRecord[] = ((members.data || []) as AnyRecord[]).filter(m => m.role !== 'super_admin');
    const joins: AnyRecord[] = ((requests.data || []) as AnyRecord[]).map(j => ({ ...j, createdAt: j.joinedAt }));
    const [assignEmail, setAssignEmail] = useState('');
    const [assignName, setAssignName] = useState('');
    const [assignRole, setAssignRole] = useState<'member' | 'admin'>('member');
    const [assigningEmp, setAssigningEmp] = useState(false);

    const submitAssignEmployee = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!assignEmail.trim()) return;
      setAssigningEmp(true);
      try {
        const res = await fetch('/api/team/assign-employee', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: assignEmail.trim(), name: assignName.trim(), role: assignRole }),
        });
        if (res.ok) {
          setNotice({ tone: 'good', text: `${assignRole === 'admin' ? 'Workspace Admin' : 'Employee'} "${assignEmail}" saved in database! When they log in via Clerk with this email, their dashboard will open immediately.` });
          setAssignEmail('');
          setAssignName('');
          qc.invalidateQueries({ queryKey: getListMembersQueryKey() });
        } else {
          const errData = await res.json().catch(() => ({}));
          setNotice({ tone: 'bad', text: errData?.error || 'Could not assign teammate.' });
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Failed to assign teammate.' });
      } finally {
        setAssigningEmp(false);
      }
    };

    return <><PageHeader title="Team" description="Manage your team members and assign workspace access." action={isAdmin ? <Btn onClick={() => document.getElementById('assign-emp-email')?.focus()}><UserPlus size={15} /> Add teammate</Btn> : null} />{notices}
      {isAdmin && <Card className="mb-4">
        <CardTitle title="Assign Teammate Access by Email (Admin or Employee)" detail="Write a teammate's email address and choose their role to save in database. When they log in with Clerk, their dashboard will open immediately." right={<UserCheck size={16} className="text-[#347858]" />} />
        <form className="flex flex-col gap-3 p-4 sm:flex-row" onSubmit={submitAssignEmployee}>
          <input id="assign-emp-email" data-testid="input-assign-employee-email" required type="email" placeholder="teammate@company.com" value={assignEmail} onChange={e => setAssignEmail(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2.5 text-[12px] outline-none focus:border-[#90b99e]" />
          <input data-testid="input-assign-employee-name" type="text" placeholder="Full name (optional)" value={assignName} onChange={e => setAssignName(e.target.value)} className="min-w-0 sm:w-44 rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2.5 text-[12px] outline-none focus:border-[#90b99e]" />
          <select value={assignRole} onChange={e => setAssignRole(e.target.value as 'member' | 'admin')} className="rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2.5 text-[12px] outline-none focus:border-[#90b99e]">
            <option value="member">Employee (Member)</option>
            <option value="admin">Workspace Admin</option>
          </select>
          <Btn type="submit" disabled={assigningEmp || !assignEmail.trim()}><Check size={14} />{assigningEmp ? 'Saving…' : `Save ${assignRole === 'admin' ? 'Admin' : 'Employee'} in Database`}</Btn>
        </form>
      </Card>}
      <Card className="mb-4"><CardTitle title="Team members" detail={`${team.length} approved members`} right={<ShieldCheck size={15} className="text-[#43815f]" />} />{members.isLoading ? <LoadingRows /> : members.isError ? <Empty title="Couldn’t load the team" detail="Refresh to check approved workspace members." button={<Btn kind="outline" onClick={() => members.refetch()}><RotateCw size={14} /> Retry</Btn>} /> : team.length ? <Table headers={['Member', 'Role', 'Status', 'Joined']} min="min-w-[580px]">{team.map(m => <tr key={m.id} data-testid={`member-${m.id}`}><td className="px-5 py-3"><div className="flex items-center gap-2.5"><Avatar name={m.name} /><div><p className="text-[12px] font-semibold text-[#35433e]">{m.name}</p><p className="text-[10px] text-[#87938e]">{m.email} · Member ID {m.id}</p></div></div></td><td className="px-4 py-3"><Badge tone={m.role === 'admin' || m.role === 'owner' ? 'purple' : 'neutral'}>{m.role}</Badge></td><td className="px-4 py-3"><ToneStatus value={m.status} /></td><td className="px-4 py-3 text-[11px] text-[#85918c]">{dateLabel(m.joinedAt)}</td></tr>)}</Table> : <Empty title="It starts with your team" detail="Your team members will appear here once assigned." />}</Card>
      {isAdmin && <Card><CardTitle title="Join requests" detail="Review new people asking to join this workspace" right={<Badge tone={joins.length ? 'amber' : 'neutral'}>{joins.length} pending</Badge>} />{requests.isLoading ? <LoadingRows /> : requests.isError ? <Empty title="Join requests unavailable" detail="Could not load pending access requests." button={<Btn kind="outline" onClick={() => requests.refetch()}><RotateCw size={14} /> Retry</Btn>} /> : joins.length ? <div className="divide-y divide-[#f0f2f1]">{joins.map(j => <div key={j.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5"><Avatar name={j.name || j.email} /><div className="min-w-[160px] flex-1"><p className="text-[12px] font-semibold">{j.name || j.email}</p><p className="mt-0.5 text-[10px] text-[#84908c]">{j.email} · Requested {dateLabel(j.createdAt)}</p></div><Badge tone="amber">Pending review</Badge><Btn kind="soft" disabled={approveRequest.isPending} onClick={() => approveRequest.mutate({ id: j.id }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListJoinRequestsQueryKey() }); qc.invalidateQueries({ queryKey: getListMembersQueryKey() }); setNotice({ tone: 'good', text: `${j.name || j.email} is now a team member.` }); }, onError: () => setNotice({ tone: 'bad', text: 'Could not approve this request.' }) })}><CheckCheck size={14} /> Approve</Btn><Btn kind="danger" disabled={rejectRequest.isPending} onClick={() => rejectRequest.mutate({ id: j.id }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListJoinRequestsQueryKey() }); setNotice({ tone: 'good', text: 'Join request declined.' }); }, onError: () => setNotice({ tone: 'bad', text: 'Could not decline this request.' }) })}><X size={14} /> Decline</Btn></div>)}</div> : <Empty title="You’re all caught up" detail="New membership requests will appear here for review." />}</Card>}
    </>;
  }
  function InboxPage() {
    const convs: AnyRecord[] = conversations.data || [];
    const teamMembersList: AnyRecord[] = ((members.data || []) as AnyRecord[]).filter(
      m => m.id !== member.id && m.role !== 'super_admin'
    );
    const filteredConvs = convs.filter(c => (c.name || '').toLowerCase().includes(search.toLowerCase()));
    const filteredTeammates = teamMembersList.filter(
      m => (m.name || '').toLowerCase().includes(search.toLowerCase()) || (m.email || '').toLowerCase().includes(search.toLowerCase())
    );

    const startDirectChatWith = (tm: AnyRecord) => {
      const existing = convs.find(c => {
        if (c.type === 'direct') {
          const names = c.memberNames || [];
          if (names.includes(tm.name) || names.includes(tm.email)) return true;
          if (c.name === tm.name || c.name === tm.email) return true;
        }
        return false;
      });
      if (existing) {
        setActiveConversation(existing.id);
        setInboxTab('chats');
        return;
      }
      createConversation.mutate(
        { data: { name: tm.name || tm.email, type: 'direct', memberIds: [tm.id] } },
        {
          onSuccess: (c: any) => {
            qc.invalidateQueries({ queryKey: getListConversationsQueryKey() });
            setActiveConversation(c.id);
            setInboxTab('chats');
            setNotice({ tone: 'good', text: `Started chat with ${tm.name || tm.email}.` });
          },
          onError: () => setNotice({ tone: 'bad', text: 'Could not start conversation.' }),
        }
      );
    };

    return (
      <>
        <PageHeader
          title="Inbox"
          description="Direct messages and group conversations with your teammates, all in one place."
          action={
            <Btn onClick={() => { setSelectedMemberIds([]); setConversationForm({ name: '', type: 'direct', memberIds: '' }); setConversationOpen(true); }}>
              <Plus size={15} /> New conversation
            </Btn>
          }
        />
        {notices}
        <Card className="grid min-h-[590px] overflow-hidden md:grid-cols-[300px_1fr]">
          <div className="flex flex-col border-r border-[#edf0ee]">
            {/* Tabs between Chats and Teammates */}
            <div className="flex border-b border-[#edf0ee] bg-[#fafbfa]">
              <button
                type="button"
                onClick={() => setInboxTab('chats')}
                className={`flex-1 py-2.5 text-center text-[11px] font-bold transition border-b-2 ${inboxTab === 'chats' ? 'border-[#28785b] text-[#28785b] bg-white' : 'border-transparent text-[#6e7d77] hover:text-[#28785b]'}`}
              >
                Chats ({convs.length})
              </button>
              <button
                type="button"
                onClick={() => setInboxTab('teammates')}
                className={`flex-1 py-2.5 text-center text-[11px] font-bold transition border-b-2 ${inboxTab === 'teammates' ? 'border-[#28785b] text-[#28785b] bg-white' : 'border-transparent text-[#6e7d77] hover:text-[#28785b]'}`}
              >
                Teammates ({teamMembersList.length})
              </button>
            </div>

            <div className="border-b border-[#edf0ee] p-3">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#97a29d]" />
                <input
                  data-testid="input-search-conversations"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={inboxTab === 'chats' ? 'Find a conversation…' : 'Find a teammate…'}
                  className="w-full rounded-lg border border-[#e4eae6] bg-[#fafbfa] py-1.5 pl-8 pr-2 text-[11px] outline-none focus:border-[#9fc5ac]"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {inboxTab === 'chats' ? (
                conversations.isLoading ? (
                  <LoadingRows />
                ) : conversations.isError ? (
                  <Empty title="Inbox unavailable" detail="We couldn’t load your conversations." button={<Btn kind="outline" onClick={() => conversations.refetch()}><RotateCw size={13} /> Retry</Btn>} />
                ) : filteredConvs.length ? (
                  filteredConvs.map(c => (
                    <button
                      key={c.id}
                      data-testid={`conversation-${c.id}`}
                      onClick={() => setActiveConversation(c.id)}
                      className={`flex w-full items-start gap-3 border-b border-[#f0f2f1] px-4 py-3 text-left transition hover:bg-[#fafcfb] ${activeConversation === c.id ? 'bg-[#f0f6f2]' : ''}`}
                    >
                      <Avatar name={c.name} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <strong className="truncate text-[11px] text-[#394841]">{c.name}</strong>
                          <span className="text-[9px] text-[#9aa49f]">{dateLabel(c.updatedAt)}</span>
                        </span>
                        <span className="mt-1 block truncate text-[10px] text-[#89948f]">{c.lastMessage || 'Start the conversation'}</span>
                        <span className="mt-1 block text-[9px] capitalize text-[#a0aaa5]">{c.type} · {(c.memberNames || []).join(', ')}</span>
                      </span>
                      {c.unreadCount > 0 && <span className="mt-1 h-2 w-2 rounded-full bg-[#43845f]" />}
                    </button>
                  ))
                ) : (
                  <div className="p-4 text-center">
                    <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-[#edf4f0] text-[#347b56]">
                      <MessageCircle size={18} />
                    </div>
                    <p className="text-[12px] font-bold text-[#35443e]">No chats yet</p>
                    <p className="mt-1 text-[11px] text-[#84928d]">Start messaging directly with your workspace teammates:</p>
                    <div className="mt-3 space-y-2 text-left">
                      {teamMembersList.length ? teamMembersList.map(tm => (
                        <div key={tm.id} className="flex items-center justify-between rounded-lg border border-[#e4eae6] bg-[#fbfcfb] p-2 hover:bg-white transition">
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar name={tm.name} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate text-[11px] font-semibold text-[#32423c]">{tm.name}</p>
                              <p className="truncate text-[9px] text-[#86928e]">{tm.role}</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => startDirectChatWith(tm)}
                            className="rounded-md bg-[#28785b] px-2.5 py-1 text-[10px] font-bold text-white hover:bg-[#20634a] transition"
                          >
                            Chat
                          </button>
                        </div>
                      )) : (
                        <p className="text-[11px] text-[#8e9d97] text-center py-2">Invite team members to begin chatting.</p>
                      )}
                    </div>
                  </div>
                )
              ) : (
                /* Teammates Tab */
                <div className="divide-y divide-[#f0f2f1]">
                  {filteredTeammates.length ? (
                    filteredTeammates.map(tm => (
                      <div key={tm.id} className="flex items-center justify-between p-3.5 transition hover:bg-[#fafcfb]">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar name={tm.name} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate text-[12px] font-semibold text-[#34443e]">{tm.name}</p>
                            <p className="truncate text-[10px] text-[#86928e]">{tm.email} · <Badge tone={tm.role === 'admin' ? 'purple' : 'neutral'}>{tm.role}</Badge></p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => startDirectChatWith(tm)}
                          className="flex items-center gap-1 rounded-md border border-[#28785b] bg-[#f0f7f3] px-2.5 py-1.5 text-[10px] font-bold text-[#28785b] hover:bg-[#28785b] hover:text-white transition"
                        >
                          <Send size={11} /> Chat
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 text-center text-[11px] text-[#84928d]">No matching teammates found.</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-[500px] flex-col bg-[#fcfdfc]">
            {activeConversation ? (
              <>
                <div className="flex items-center gap-3 border-b border-[#edf0ee] bg-white px-5 py-3.5">
                  <Avatar name={convs.find(c => c.id === activeConversation)?.name} size="sm" />
                  <div>
                    <p className="text-[12px] font-bold">{convs.find(c => c.id === activeConversation)?.name}</p>
                    <p className="text-[10px] text-[#87938e]">{(convs.find(c => c.id === activeConversation)?.memberNames || []).join(' · ')}</p>
                  </div>
                </div>
                <div className="flex-1 space-y-4 overflow-y-auto p-5">
                  {messages.isLoading ? (
                    <LoadingRows />
                  ) : messages.isError ? (
                    <Empty title="Messages could not load" detail="Try again to retrieve your conversation history." button={<Btn kind="outline" onClick={() => messages.refetch()}><RotateCw size={13} /> Retry</Btn>} />
                  ) : (messages.data as AnyRecord[] || []).length ? (
                    (messages.data as AnyRecord[]).map(m => (
                      <div key={m.id} data-testid={`message-${m.id}`} className={`flex gap-2.5 ${m.senderId === member.id ? 'flex-row-reverse' : ''}`}>
                        <Avatar name={m.senderName} size="sm" />
                        <div className={`max-w-[75%] rounded-xl px-3.5 py-2.5 ${m.senderId === member.id ? 'bg-[#e8f2eb] text-[#31473a]' : 'border border-[#e8eeea] bg-white text-[#4e5b56]'}`}>
                          <p className="mb-1 text-[9px] font-bold text-[#75827d]">{m.senderName}</p>
                          <p className="whitespace-pre-wrap text-[12px] leading-5">{m.body}</p>
                          <p className="mt-1 text-right text-[9px] text-[#98a39e]">{new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(m.createdAt))}</p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <Empty title="Start with a hello" detail="Send a message to start this conversation." />
                  )}
                </div>
                <form
                  className="flex items-end gap-2 border-t border-[#edf0ee] bg-white p-3"
                  onSubmit={e => {
                    e.preventDefault();
                    if (!messageBody.trim() || !activeConversation) return;
                    createMessage.mutate(
                      { id: activeConversation, data: { body: messageBody.trim() } },
                      {
                        onSuccess: () => {
                          qc.invalidateQueries({ queryKey: getListMessagesQueryKey(activeConversation) });
                          qc.invalidateQueries({ queryKey: getListConversationsQueryKey() });
                          setMessageBody('');
                          setNotice({ tone: 'good', text: 'Message sent.' });
                        },
                        onError: () => setNotice({ tone: 'bad', text: 'Message could not be sent. Try again.' }),
                      }
                    );
                  }}
                >
                  <textarea
                    data-testid="input-message-body"
                    value={messageBody}
                    onChange={e => setMessageBody(e.target.value)}
                    rows={1}
                    placeholder="Write a message…"
                    className="max-h-28 min-h-10 flex-1 resize-y rounded-lg border border-[#e2e9e5] bg-[#fafbfa] px-3 py-2.5 text-[12px] outline-none focus:border-[#9fc5ac]"
                  />
                  <Btn type="submit" disabled={!messageBody.trim() || createMessage.isPending} className="h-10 w-10 px-0">
                    <Send size={15} />
                  </Btn>
                </form>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#edf4f0] text-[#428263]">
                  <MessageCircle size={20} />
                </span>
                <h3 className="mt-4 text-[14px] font-bold text-[#35443e]">Your team, in the loop</h3>
                <p className="mt-1 max-w-xs text-[11px] leading-5 text-[#85918c]">Pick a conversation to catch up, or start a new one with your teammates.</p>
                <div className="mt-4 flex gap-2">
                  <Btn onClick={() => { setSelectedMemberIds([]); setConversationOpen(true); }}><Plus size={13} /> New conversation</Btn>
                  <Btn kind="outline" onClick={() => setInboxTab('teammates')}>View Teammates</Btn>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Modal with teammate checkboxes */}
        {conversationOpen && (
          <Dialog title="New conversation" onClose={() => setConversationOpen(false)}>
            <form
              className="space-y-4 p-5"
              onSubmit={e => {
                e.preventDefault();
                if (!selectedMemberIds.length) {
                  setNotice({ tone: 'bad', text: 'Please select at least one teammate.' });
                  return;
                }
                const defaultName = selectedMemberIds.length === 1
                  ? teamMembersList.find(m => m.id === selectedMemberIds[0])?.name || 'Direct Chat'
                  : `Group (${selectedMemberIds.length} members)`;
                const convName = conversationForm.name.trim() || defaultName;

                createConversation.mutate(
                  { data: { name: convName, type: (selectedMemberIds.length > 1 ? 'group' : conversationForm.type) as any, memberIds: selectedMemberIds } },
                  {
                    onSuccess: (c: any) => {
                      qc.invalidateQueries({ queryKey: getListConversationsQueryKey() });
                      setConversationOpen(false);
                      setActiveConversation(c.id);
                      setInboxTab('chats');
                      setNotice({ tone: 'good', text: 'Conversation created.' });
                    },
                    onError: () => setNotice({ tone: 'bad', text: 'Conversation could not be created.' }),
                  }
                );
              }}
            >
              <FieldInput field={{ key: 'name', label: 'Conversation name (optional for direct chats)' }} value={conversationForm.name} set={v => setConversationForm({ ...conversationForm, name: v })} />
              <FieldInput field={{ key: 'type', label: 'Type', options: ['direct', 'group'] }} value={conversationForm.type} set={v => setConversationForm({ ...conversationForm, type: v })} />

              <div>
                <label className="block text-[12px] font-semibold text-[#52605d] mb-1.5">
                  Select Teammates ({selectedMemberIds.length} selected)
                </label>
                {teamMembersList.length ? (
                  <div className="max-h-52 overflow-y-auto space-y-1 rounded-lg border border-[#dce5e0] bg-[#fbfcfb] p-2">
                    {teamMembersList.map(tm => {
                      const isSelected = selectedMemberIds.includes(tm.id);
                      return (
                        <button
                          key={tm.id}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setSelectedMemberIds(selectedMemberIds.filter(id => id !== tm.id));
                            } else {
                              setSelectedMemberIds([...selectedMemberIds, tm.id]);
                              if (!conversationForm.name) {
                                setConversationForm(cf => ({ ...cf, name: tm.name }));
                              }
                            }
                          }}
                          className={`flex w-full items-center justify-between rounded-md p-2 text-left transition ${isSelected ? 'bg-[#e7f3ec] text-[#246b4e]' : 'hover:bg-white text-[#384842]'}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              readOnly
                              className="h-3.5 w-3.5 rounded border-[#c5d5cd] text-[#28785b] focus:ring-0"
                            />
                            <Avatar name={tm.name} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate text-[11px] font-bold">{tm.name}</p>
                              <p className="truncate text-[9px] text-[#788882]">{tm.email} · {tm.role}</p>
                            </div>
                          </div>
                          {isSelected && <Check size={14} className="text-[#28785b]" />}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-[#7e8e88] italic">No approved teammates found in workspace.</p>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-3">
                <Btn kind="outline" onClick={() => setConversationOpen(false)}>Cancel</Btn>
                <Btn type="submit" disabled={createConversation.isPending || !selectedMemberIds.length}>
                  {createConversation.isPending ? 'Creating…' : 'Start conversation'}
                </Btn>
              </div>
            </form>
          </Dialog>
        )}
      </>
    );
  }
  function Community() {
    const list: AnyRecord[] = posts.data || [];
    return (
      <>
        <PageHeader
          title="Community"
          description="Trade hard-won lessons with the people building alongside you."
          action={<Btn onClick={() => setPostOpen(true)}><Plus size={15} /> Start a conversation</Btn>}
        />
        {notices}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-3">
            {posts.isLoading ? (
              <Card><LoadingRows /></Card>
            ) : posts.isError ? (
              <Card>
                <Empty
                  title="Community feed unavailable"
                  detail="We couldn’t load the latest conversations."
                  button={<Btn kind="outline" onClick={() => posts.refetch()}><RotateCw size={13} /> Retry</Btn>}
                />
              </Card>
            ) : list.length ? (
              list.map(p => (
                <Card key={p.id} data-testid={`post-${p.id}`}>
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={p.author} />
                        <div>
                          <p className="text-[12px] font-bold text-[#3c4b45]">{p.author}</p>
                          <p className="mt-0.5 text-[10px] text-[#8a9691]">{dateLabel(p.createdAt)}</p>
                        </div>
                      </div>
                      <Badge tone="blue">{p.category || 'Community'}</Badge>
                    </div>
                    <h2 className="mt-4 font-display text-[16px] font-bold tracking-tight text-[#34423d]">{p.title}</h2>
                    <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-[#687671]">{p.body}</p>
                    <div className="mt-4 flex items-center gap-4 border-t border-[#eef1ef] pt-3">
                      <span className="inline-flex items-center gap-1.5 text-[10px] text-[#82908a]">
                        <TrendingUp size={13} /> {p.likes || 0} people found this useful
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-[10px] text-[#82908a]">
                        <MessageSquareText size={13} /> {p.comments?.length || 0} replies
                      </span>
                    </div>
                    {p.comments?.length > 0 && (
                      <div className="mt-2 space-y-2 border-l-2 border-[#e6eee8] pl-3">
                        {p.comments.map((c: AnyRecord) => (
                          <div key={c.id} className="rounded-lg bg-[#f8faf8] px-3 py-2">
                            <span className="text-[10px] font-bold text-[#53635c]">{c.author}</span>
                            <span className="ml-2 text-[9px] text-[#9aa49f]">{dateLabel(c.createdAt)}</span>
                            <p className="mt-1 text-[11px] leading-5 text-[#6c7973]">{c.body}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <PostCommentInput
                      postId={p.id}
                      isPending={createComment.isPending}
                      onComment={(postId, body) => {
                        createComment.mutate(
                          { id: postId, data: { body } },
                          {
                            onSuccess: () => {
                              qc.invalidateQueries({ queryKey: getListCommunityPostsQueryKey() });
                              setNotice({ tone: 'good', text: 'Reply added to the conversation.' });
                            },
                            onError: () => setNotice({ tone: 'bad', text: 'Your reply could not be posted. Try again.' }),
                          }
                        );
                      }}
                    />
                  </div>
                </Card>
              ))
            ) : (
              <Card>
                <Empty
                  title="A good community starts with a question"
                  detail="Share a founder challenge, a useful lesson, or a win worth passing on."
                  button={<Btn onClick={() => setPostOpen(true)}><Plus size={14} /> Write the first post</Btn>}
                />
              </Card>
            )}
          </div>
          <aside className="space-y-3">
            <Card>
              <div className="p-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#edf4ef] text-[#43815f]">
                  <Globe2 size={17} />
                </div>
                <h3 className="mt-3 text-[13px] font-bold">A room for builders</h3>
                <p className="mt-1 text-[11px] leading-5 text-[#7c8983]">Ask openly, give context, and share the playbook you wish you had sooner.</p>
                <Btn kind="soft" className="mt-4 w-full" onClick={() => setPostOpen(true)}>
                  <Plus size={13} /> Start a post
                </Btn>
              </div>
            </Card>
            <Card>
              <CardTitle title="Good community habits" />
              <div className="space-y-3 p-4">
                <p className="flex gap-2 text-[10px] leading-4 text-[#687670]">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#41825e]" /> Include context so answers can be useful.
                </p>
                <p className="flex gap-2 text-[10px] leading-4 text-[#687670]">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#41825e]" /> Give feedback generously and specifically.
                </p>
                <p className="flex gap-2 text-[10px] leading-4 text-[#687670]">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#41825e]" /> Share what worked, not just what should.
                </p>
              </div>
            </Card>
          </aside>
        </div>
        {postOpen && (
          <Dialog title="Start a conversation" onClose={() => setPostOpen(false)}>
            <form
              className="space-y-4 p-5"
              onSubmit={e => {
                e.preventDefault();
                createPost.mutate(
                  { data: postForm },
                  {
                    onSuccess: () => {
                      qc.invalidateQueries({ queryKey: getListCommunityPostsQueryKey() });
                      setPostOpen(false);
                      setPostForm({ title: '', body: '', category: 'Founder question' });
                      setNotice({ tone: 'good', text: 'Your post is live in the community.' });
                    },
                    onError: () => setNotice({ tone: 'bad', text: 'Post could not be published. Check the details and try again.' }),
                  }
                );
              }}
            >
              <FieldInput field={{ key: 'title', label: 'Title', required: true }} value={postForm.title} set={v => setPostForm({ ...postForm, title: v })} />
              <FieldInput field={{ key: 'category', label: 'Topic', options: ['Founder question', 'Go-to-market', 'Hiring', 'Product', 'Milestone'] }} value={postForm.category} set={v => setPostForm({ ...postForm, category: v })} />
              <FieldInput field={{ key: 'body', label: 'What’s on your mind?', type: 'textarea', required: true }} value={postForm.body} set={v => setPostForm({ ...postForm, body: v })} />
              <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-4">
                <Btn kind="outline" onClick={() => setPostOpen(false)}>Cancel</Btn>
                <Btn type="submit" disabled={createPost.isPending}>
                  <Send size={14} /> {createPost.isPending ? 'Publishing…' : 'Publish post'}
                </Btn>
              </div>
            </form>
          </Dialog>
        )}
      </>
    );
  }

  function SuperAdminPage() {
    const [companiesList, setCompaniesList] = useState<AnyRecord[]>([]);
    const [loadingComps, setLoadingComps] = useState(true);
    const [pendingRequests, setPendingRequests] = useState<AnyRecord[]>([]);
    const [loadingPending, setLoadingPending] = useState(true);
    const [allUsers, setAllUsers] = useState<AnyRecord[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [createOpen, setCreateOpen] = useState(false);
    const [compForm, setCompForm] = useState({
      name: '', adminName: '', adminEmail: '', industry: 'Software', size: '1-10', website: ''
    });
    const [savingComp, setSavingComp] = useState(false);

    const loadCompanies = useCallback(async () => {
      setLoadingComps(true);
      try {
        const res = await fetch('/api/superadmin/companies', { credentials: 'include' });
        if (res.ok) setCompaniesList(await res.json());
      } catch {
        setNotice({ tone: 'bad', text: 'Could not load companies list.' });
      } finally {
        setLoadingComps(false);
      }
    }, []);

    const loadPending = useCallback(async () => {
      setLoadingPending(true);
      try {
        const res = await fetch('/api/superadmin/pending-requests', { credentials: 'include' });
        if (res.ok) setPendingRequests(await res.json());
      } catch {
        // silent fallback
      } finally {
        setLoadingPending(false);
      }
    }, []);

    const loadAllUsers = useCallback(async () => {
      setLoadingUsers(true);
      try {
        const res = await fetch('/api/superadmin/all-users', { credentials: 'include' });
        if (res.ok) setAllUsers(await res.json());
      } catch {
        // silent fallback
      } finally {
        setLoadingUsers(false);
      }
    }, []);

    useEffect(() => {
      void loadCompanies();
      void loadPending();
      void loadAllUsers();
      const interval = setInterval(() => {
        void loadCompanies();
        void loadPending();
        void loadAllUsers();
      }, 4000);
      return () => clearInterval(interval);
    }, [loadCompanies, loadPending, loadAllUsers]);

    const toggleUserRole = async (u: AnyRecord) => {
      const newRole = u.role === 'admin' ? 'member' : 'admin';
      try {
        const res = await fetch(`/api/superadmin/users/${u.id}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        if (res.ok) {
          setNotice({ tone: 'good', text: `${u.name || u.email} role changed to ${newRole === 'admin' ? 'Workspace Admin' : 'Employee'}.` });
          void loadAllUsers();
          void loadCompanies();
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Failed to update user role.' });
      }
    };

    const deleteUserRecord = async (u: AnyRecord) => {
      if (!confirm(`Are you sure you want to remove access for "${u.name || u.email}"?`)) return;
      try {
        const res = await fetch(`/api/superadmin/users/${u.id}`, { method: 'DELETE', credentials: 'include' });
        if (res.ok) {
          setNotice({ tone: 'good', text: `User ${u.email} removed.` });
          void loadAllUsers();
          void loadCompanies();
          void loadPending();
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Error removing user.' });
      }
    };

    const approveUserAsAdmin = async (id: number, email: string) => {
      try {
        const res = await fetch(`/api/superadmin/requests/${id}/approve-admin`, {
          method: 'POST', credentials: 'include'
        });
        if (res.ok) {
          setNotice({ tone: 'good', text: `User ${email} approved as Workspace Admin.` });
          void loadPending();
          void loadCompanies();
          void loadAllUsers();
        } else {
          setNotice({ tone: 'bad', text: 'Could not approve request.' });
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Failed to approve request.' });
      }
    };

    const approveUserAsEmployee = async (id: number, email: string) => {
      try {
        const res = await fetch(`/api/superadmin/requests/${id}/approve-employee`, {
          method: 'POST', credentials: 'include'
        });
        if (res.ok) {
          setNotice({ tone: 'good', text: `User ${email} approved as Employee.` });
          void loadPending();
          void loadCompanies();
          void loadAllUsers();
        } else {
          setNotice({ tone: 'bad', text: 'Could not approve request.' });
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Failed to approve request.' });
      }
    };

    const rejectUserRequest = async (id: number, email: string) => {
      if (!confirm(`Decline access request for ${email}?`)) return;
      try {
        const res = await fetch(`/api/superadmin/requests/${id}/reject`, {
          method: 'POST', credentials: 'include'
        });
        if (res.ok) {
          setNotice({ tone: 'good', text: `Access request declined for ${email}.` });
          void loadPending();
          void loadAllUsers();
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Could not decline request.' });
      }
    };

    const submitCreateCompany = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!compForm.name.trim() || !compForm.adminEmail.trim()) return;
      setSavingComp(true);
      try {
        const res = await fetch('/api/superadmin/companies', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(compForm),
        });
        if (res.ok) {
          setNotice({ tone: 'good', text: `Company "${compForm.name}" created! Admin "${compForm.adminEmail}" will be able to log in via Clerk.` });
          setCreateOpen(false);
          setCompForm({ name: '', adminName: '', adminEmail: '', industry: 'Software', size: '1-10', website: '' });
          void loadCompanies();
          void loadAllUsers();
        } else {
          const err = await res.json().catch(() => ({}));
          setNotice({ tone: 'bad', text: err?.error || 'Could not create company.' });
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Failed to create company.' });
      } finally {
        setSavingComp(false);
      }
    };

    const deleteCompanyItem = async (c: AnyRecord) => {
      if (!confirm(`Are you sure you want to delete "${c.name}"? This removes all company users.`)) return;
      try {
        const res = await fetch(`/api/superadmin/companies/${c.id}`, { method: 'DELETE', credentials: 'include' });
        if (res.ok) {
          setNotice({ tone: 'good', text: `Company "${c.name}" deleted.` });
          void loadCompanies();
          void loadAllUsers();
        }
      } catch {
        setNotice({ tone: 'bad', text: 'Error deleting company.' });
      }
    };

    return <>
      <PageHeader
        title="Super Admin Workspace Management"
        description="Review user access requests and manage workspace admins. Add companies (with their admin) from the Companies page or use the button below."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Btn onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Add Admin & Company Workspace
            </Btn>
            <Btn kind="outline" onClick={() => { void loadCompanies(); void loadPending(); void loadAllUsers(); }}>
              <RotateCw size={13} className={loadingUsers || loadingPending || loadingComps ? 'animate-spin' : ''} /> Refresh
            </Btn>
          </div>
        }
      />
      {notices}

      {/* Card 2: Pending User Requests with Custom Messages */}
      <Card className="mb-5">
        <CardTitle
          title="Pending User Access Requests"
          detail="Review sign-ins waiting for Super Admin approval, along with their custom notification message"
          right={<Badge tone={pendingRequests.length ? 'amber' : 'neutral'}>{pendingRequests.length} pending</Badge>}
        />
        {loadingPending ? (
          <LoadingRows />
        ) : pendingRequests.length ? (
          <div className="divide-y divide-[#f0f2f1]">
            {pendingRequests.map(req => (
              <div key={req.id} className="p-5 transition hover:bg-[#fafcfb]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={req.name || req.email} />
                    <div>
                      <p className="text-[13px] font-bold text-[#2a3a35]">{req.name || req.email}</p>
                      <p className="font-mono text-[11px] text-[#71817c]">{req.email} · Requested {dateLabel(req.joinedAt)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Btn kind="primary" onClick={() => approveUserAsAdmin(req.id, req.email)}>
                      <ShieldCheck size={14} /> Approve as Admin
                    </Btn>
                    <Btn kind="soft" onClick={() => approveUserAsEmployee(req.id, req.email)}>
                      <UserCheck size={14} /> Approve as Employee
                    </Btn>
                    <Btn kind="danger" onClick={() => rejectUserRequest(req.id, req.email)}>
                      <X size={14} /> Decline
                    </Btn>
                  </div>
                </div>
                {req.requestMessage ? (
                  <div className="mt-3 rounded-xl border border-[#dbe6df] bg-[#f7faf8] p-3.5 text-[12px] text-[#2c4e3e]">
                    <span className="font-bold text-[#1f4a33]">User Custom Message:</span> “{req.requestMessage}”
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-[#93a09b] italic">No custom message submitted yet.</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="All access requests processed"
            detail="When new unassigned users sign in through Clerk, their account will be blocked and their custom message will appear here for your approval."
          />
        )}
      </Card>

      {/* Card 3: All Workspace Users & Access Control Directory */}
      <Card className="mb-5">
        <CardTitle
          title="All Workspace Users & Access Directory"
          detail="Complete list of all approved Workspace Admins, Employees, and their workspace status"
          right={<Badge tone={allUsers.length ? 'purple' : 'neutral'}>{allUsers.length} total users</Badge>}
        />
        {loadingUsers ? (
          <LoadingRows />
        ) : allUsers.length ? (
          <Table headers={['Member', 'Role', 'Assigned Workspace', 'Access Status', 'Joined', 'Actions']}>
            {allUsers.map(u => (
              <tr key={u.id}>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={u.name || u.email} />
                    <div>
                      <p className="text-[12px] font-bold text-[#273832]">{u.name || u.email}</p>
                      <p className="font-mono text-[10px] text-[#71817c]">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={u.role === 'admin' ? 'purple' : 'neutral'}>
                    {u.role === 'admin' ? 'Workspace Admin' : 'Employee'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-[12px] font-medium text-[#3b4c46]">
                  {u.companyName ? (
                    <span className="flex items-center gap-1.5"><Building2 size={13} className="text-[#3b7e5b]" /> {u.companyName}</span>
                  ) : (
                    <span className="text-[#9aa5a1] italic">Unassigned</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={u.status === 'active' ? 'green' : u.status === 'rejected' ? 'red' : 'amber'}>
                    {u.status === 'active' ? 'Active Approved' : u.status === 'rejected' ? 'Rejected' : 'Pending Approval'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-[11px] text-[#85918c]">{dateLabel(u.joinedAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    {u.status === 'pending' ? (
                      <>
                        <Btn kind="primary" onClick={() => approveUserAsAdmin(u.id, u.email)}>
                          <ShieldCheck size={12} /> Approve Admin
                        </Btn>
                        <Btn kind="soft" onClick={() => approveUserAsEmployee(u.id, u.email)}>
                          <UserCheck size={12} /> Approve Employee
                        </Btn>
                      </>
                    ) : (
                      <Btn kind="outline" onClick={() => toggleUserRole(u)}>
                        Switch to {u.role === 'admin' ? 'Employee' : 'Admin'}
                      </Btn>
                    )}
                    <Btn kind="danger" onClick={() => deleteUserRecord(u)}>
                      <Trash2 size={13} /> Remove
                    </Btn>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="No users registered yet" detail="When users sign up via Clerk or are invited by team admins, they will appear in this directory." />
        )}
      </Card>

      {/* Card 3: Registered Companies & Admins */}
      <Card>
        <CardTitle
          title="Registered Companies & Workspace Admins"
          detail={`${companiesList.length} total companies`}
          right={
            <div className="flex items-center gap-2">
              <Btn onClick={() => setCreateOpen(true)} className="text-[12px] py-1.5 px-3">
                <Plus size={13} /> Add Company Admin
              </Btn>
            </div>
          }
        />
        {loadingComps ? <LoadingRows /> : companiesList.length ? <Table headers={['Company Workspace', 'Assigned Admin', 'Status', 'Members', 'Actions']}>
          {companiesList.map(c => <tr key={c.id}>
            <td className="px-5 py-3">
              <div><p className="text-[12px] font-bold text-[#273832]">{c.name}</p><p className="text-[10px] text-[#808d87]">{c.industry} · {c.website || 'No website'}</p></div>
            </td>
            <td className="px-4 py-3">
              <div><p className="text-[12px] font-semibold text-[#32423d]">{c.adminName}</p><p className="text-[10px] font-mono text-[#667671]">{c.adminEmail}</p></div>
            </td>
            <td className="px-4 py-3">
              <Badge tone="purple">Admin Active</Badge>
            </td>
            <td className="px-4 py-3 text-[12px] font-semibold text-[#485752]">{c.memberCount}</td>
            <td className="px-4 py-3">
              <Btn kind="danger" onClick={() => deleteCompanyItem(c)}><Trash2 size={13} /> Delete</Btn>
            </td>
          </tr>)}
        </Table> : <Empty title="No companies configured" detail="Create your first company workspace to assign admin credentials." button={<Btn onClick={() => setCreateOpen(true)}><Plus size={14} /> Add Admin & Company Workspace</Btn>} />}
      </Card>
      {createOpen && (
        <Dialog title="Add Workspace Admin & Company" onClose={() => setCreateOpen(false)}>
          <form className="space-y-4 p-5" onSubmit={submitCreateCompany}>
            <p className="text-[12px] leading-5 text-[#596963]">
              Creating a company workspace and assigning an admin email grants that user instant access to the platform once they log in via Clerk.
            </p>
            <FieldInput
              field={{ key: 'name', label: 'Company Name', required: true }}
              value={compForm.name}
              set={v => setCompForm(f => ({ ...f, name: v }))}
            />
            <FieldInput
              field={{ key: 'adminName', label: 'Admin Full Name', required: true }}
              value={compForm.adminName}
              set={v => setCompForm(f => ({ ...f, adminName: v }))}
            />
            <FieldInput
              field={{ key: 'adminEmail', label: 'Admin Email (Clerk Login)', required: true }}
              value={compForm.adminEmail}
              set={v => setCompForm(f => ({ ...f, adminEmail: v }))}
            />
            <div className="grid grid-cols-2 gap-3">
              <FieldInput
                field={{ key: 'industry', label: 'Industry', options: ['Software', 'Fintech', 'Healthtech', 'Ecommerce', 'Services', 'Manufacturing', 'Other'] }}
                value={compForm.industry}
                set={v => setCompForm(f => ({ ...f, industry: v }))}
              />
              <FieldInput
                field={{ key: 'size', label: 'Company Size', options: ['1-10', '11-50', '51-200', '201-500', '500+'] }}
                value={compForm.size}
                set={v => setCompForm(f => ({ ...f, size: v }))}
              />
            </div>
            <FieldInput
              field={{ key: 'website', label: 'Website (Optional)' }}
              value={compForm.website}
              set={v => setCompForm(f => ({ ...f, website: v }))}
            />
            <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-4">
              <Btn kind="outline" onClick={() => setCreateOpen(false)}>Cancel</Btn>
              <Btn type="submit" disabled={savingComp || !compForm.name.trim() || !compForm.adminEmail.trim()}>
                {savingComp ? 'Creating…' : 'Create Admin & Workspace'}
              </Btn>
            </div>
          </form>
        </Dialog>
      )}
    </>;
  }

  function NotesPage() {
    const isSuperAdmin = member?.role === 'super_admin';
    const [noteFilter, setNoteFilter] = useState<'all' | 'mine' | 'shared' | 'pinned'>('all');
    const [noteCategory, setNoteCategory] = useState<string>('all');
    const [noteSearch, setNoteSearch] = useState<string>('');
    const [modalOpen, setModalOpen] = useState(false);
    const [editingNote, setEditingNote] = useState<AnyRecord | null>(null);
    const [copiedId, setCopiedId] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const [togglingShareId, setTogglingShareId] = useState<number | null>(null);
    const [togglingPinId, setTogglingPinId] = useState<number | null>(null);
    const [deletingId, setDeletingId] = useState<number | null>(null);

    const [form, setForm] = useState({
      title: '',
      content: '',
      category: 'General',
      color: 'default',
      isPinned: false,
      isShared: false,
    });

    const { data: notesList = [], isLoading, refetch } = useQuery<AnyRecord[]>({
      queryKey: ['speedmatch-notes', noteFilter, noteCategory, noteSearch],
      queryFn: async () => {
        const params = new URLSearchParams();
        if (noteFilter && noteFilter !== 'all') params.set('filter', noteFilter);
        if (noteCategory && noteCategory !== 'all') params.set('category', noteCategory);
        if (noteSearch) params.set('search', noteSearch);
        const res = await fetch(`/api/notes?${params.toString()}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load notes');
        return (await res.json()) as AnyRecord[];
      },
      refetchInterval: 10_000,
    });

    const categories = [
      'All Topics',
      'General',
      'Meeting Notes',
      'Strategy & Pitch',
      'Ideas & Brainstorm',
      'Call Log',
      'Code & Scratchpad',
      'Important Links',
      'Checklist',
    ];

    const openCreateModal = () => {
      setEditingNote(null);
      setForm({
        title: '',
        content: '',
        category: 'General',
        color: 'default',
        isPinned: false,
        isShared: false,
      });
      setModalOpen(true);
    };

    const openEditModal = (note: AnyRecord) => {
      setEditingNote(note);
      setForm({
        title: note.title || '',
        content: note.content || '',
        category: note.category || 'General',
        color: note.color || 'default',
        isPinned: Boolean(note.isPinned),
        isShared: Boolean(note.isShared),
      });
      setModalOpen(true);
    };

    const handleSaveNote = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.title.trim()) return;
      setSaving(true);
      try {
        const url = editingNote ? `/api/notes/${editingNote.id}` : '/api/notes';
        const method = editingNote ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: form.title.trim(),
            content: form.content,
            category: form.category,
            color: form.color,
            isPinned: form.isPinned ? 1 : 0,
            isShared: form.isShared ? 1 : 0,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to save note');
        }
        await refetch();
        setModalOpen(false);
        setNotice({
          tone: 'good',
          text: editingNote
            ? 'Note updated successfully.'
            : form.isShared
              ? 'Note created and shared with your workspace team!'
              : 'Private note saved to your personal scratchpad.',
        });
      } catch (err: any) {
        setNotice({ tone: 'bad', text: err.message || 'Could not save note.' });
      } finally {
        setSaving(false);
      }
    };

    const handleToggleShare = async (note: AnyRecord) => {
      setTogglingShareId(note.id);
      try {
        const res = await fetch(`/api/notes/${note.id}/toggle-share`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to toggle share status');
        }
        const updated = await res.json();
        await refetch();
        setNotice({
          tone: 'good',
          text: updated.isShared
            ? `“${updated.title}” is now shared with your workspace team.`
            : `“${updated.title}” is now private to you.`,
        });
      } catch (err: any) {
        setNotice({ tone: 'bad', text: err.message || 'Could not update note sharing.' });
      } finally {
        setTogglingShareId(null);
      }
    };

    const handleTogglePin = async (note: AnyRecord) => {
      setTogglingPinId(note.id);
      try {
        const res = await fetch(`/api/notes/${note.id}/toggle-pin`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to toggle pin');
        }
        await refetch();
      } catch (err: any) {
        setNotice({ tone: 'bad', text: err.message || 'Could not toggle pin.' });
      } finally {
        setTogglingPinId(null);
      }
    };

    const handleDeleteNote = async (note: AnyRecord) => {
      if (!window.confirm(`Are you sure you want to delete note “${note.title}”?`)) return;
      setDeletingId(note.id);
      try {
        const res = await fetch(`/api/notes/${note.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to delete note');
        }
        await refetch();
        setNotice({ tone: 'good', text: 'Note deleted.' });
      } catch (err: any) {
        setNotice({ tone: 'bad', text: err.message || 'Could not delete note.' });
      } finally {
        setDeletingId(null);
      }
    };

    const handleCopyContent = (note: AnyRecord) => {
      const textToCopy = `${note.title}\n\n${note.content || ''}`;
      navigator.clipboard.writeText(textToCopy);
      setCopiedId(note.id);
      setTimeout(() => setCopiedId(null), 2000);
    };

    const getColorClass = (color: string) => {
      switch (color) {
        case 'emerald':
          return {
            card: 'border-[#c8e6d5] bg-[#f7fbf8] hover:border-[#96d1af]',
            header: 'border-[#dff0e6] bg-[#edf7f1]',
            badge: 'bg-[#ddf2e5] text-[#206945]',
            accent: 'bg-[#28785b]',
          };
        case 'amber':
          return {
            card: 'border-[#fbe2b5] bg-[#fffcf5] hover:border-[#f9cb79]',
            header: 'border-[#faedd3] bg-[#fdf6e7]',
            badge: 'bg-[#fcedcf] text-[#8c5d14]',
            accent: 'bg-[#e59b20]',
          };
        case 'blue':
          return {
            card: 'border-[#cbe1f7] bg-[#f6fafe] hover:border-[#95c2f0]',
            header: 'border-[#dfeaf8] bg-[#edf4fd]',
            badge: 'bg-[#dce9fc] text-[#1c558c]',
            accent: 'bg-[#2b75be]',
          };
        case 'purple':
          return {
            card: 'border-[#e4d6f8] bg-[#faf7ff] hover:border-[#caaef2]',
            header: 'border-[#eee3fb] bg-[#f4ebfe]',
            badge: 'bg-[#ede0fd] text-[#5e2b9c]',
            accent: 'bg-[#7a3dbf]',
          };
        case 'rose':
          return {
            card: 'border-[#f9ceca] bg-[#fef7f6] hover:border-[#f3a097]',
            header: 'border-[#f8dedb] bg-[#fdeeed]',
            badge: 'bg-[#fcdedb] text-[#9b2b22]',
            accent: 'bg-[#c53b30]',
          };
        default:
          return {
            card: 'border-[#e2e9e5] bg-white hover:border-[#bdd7c8]',
            header: 'border-[#edf0ee] bg-[#fbfdfc]',
            badge: 'bg-[#f0f3f2] text-[#556360]',
            accent: 'bg-[#51645e]',
          };
      }
    };

    const totalCount = notesList.length;
    const myCount = notesList.filter(n => n.authorId === member?.id).length;
    const sharedCount = notesList.filter(n => Boolean(n.isShared)).length;
    const pinnedCount = notesList.filter(n => Boolean(n.isPinned)).length;

    return (
      <div className="space-y-6">
        <PageHeader
          title="Notes & Scratchpad"
          description="Capture meeting notes, ideas, code snippets, strategies, and important links. Keep them private to you or share them with your team."
          action={
            <div className="flex items-center gap-3">
              <Btn onClick={openCreateModal}>
                <Plus size={15} /> New Note
              </Btn>
            </div>
          }
        />

        {/* Quick Metrics Bar */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">Total Notes</div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#23332e]">{totalCount}</div>
          </Card>
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">My Notes</div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#28785b]">{myCount}</div>
          </Card>
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">Shared with Team</div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#2b75be]">{sharedCount}</div>
          </Card>
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">Pinned to Top</div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#e59b20]">{pinnedCount}</div>
          </Card>
        </div>

        {/* Toolbar & Filters */}
        <div className="flex flex-col gap-3 rounded-xl border border-[#e2e9e5] bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          {/* Main Filter Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'all', label: 'All Notes', count: totalCount },
              { id: 'mine', label: 'My Notes', count: myCount },
              { id: 'shared', label: 'Shared with Team', count: sharedCount },
              { id: 'pinned', label: 'Pinned', count: pinnedCount },
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setNoteFilter(tab.id as any)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${noteFilter === tab.id
                    ? 'bg-[#28785b] text-white shadow-sm'
                    : 'bg-[#f4f7f5] text-[#556560] hover:bg-[#e9eee9]'
                  }`}
              >
                <span>{tab.label}</span>
                <span className={`rounded-full px-1.5 py-0.2 text-[10px] ${noteFilter === tab.id ? 'bg-white/25 text-white' : 'bg-black/5 text-[#6a7974]'}`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Search Bar */}
          <div className="relative min-w-[240px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8b9993]" />
            <input
              type="text"
              placeholder="Search notes, tags, content…"
              value={noteSearch}
              onChange={e => setNoteSearch(e.target.value)}
              className="w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] py-1.5 pl-9 pr-3 text-[12px] text-[#2f3f3a] outline-none transition focus:border-[#70a88c] focus:ring-2 focus:ring-[#28785b]/10"
            />
          </div>
        </div>

        {/* Category Filter Chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-bold text-[#808f8a]">
            <Tag size={12} /> Topic:
          </span>
          {categories.map(cat => {
            const val = cat === 'All Topics' ? 'all' : cat;
            const active = noteCategory === val;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setNoteCategory(val)}
                className={`shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium transition ${active
                    ? 'border-[#28785b] bg-[#edf6f1] text-[#22634b]'
                    : 'border-[#dfe6e2] bg-white text-[#657570] hover:border-[#b8ccc2]'
                  }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        {/* Notes Grid */}
        {isLoading ? (
          <LoadingRows />
        ) : notesList.length === 0 ? (
          <Card className="mx-auto max-w-lg p-10 text-center">
            <Empty
              title="No notes found"
              detail={
                noteSearch || noteCategory !== 'all' || noteFilter !== 'all'
                  ? 'No notes match your current filters. Try clearing filters or search terms.'
                  : 'Capture anything here — meeting records, brainstorm ideas, code snippets, or team strategy.'
              }
              button={
                <Btn onClick={openCreateModal}>
                  <Plus size={14} /> Create your first note
                </Btn>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {notesList.map(note => {
              const colors = getColorClass(note.color || 'default');
              const isOwner = note.authorId === member?.id;
              const canEdit = isOwner || member?.role === 'admin' || isSuperAdmin;
              const isCopied = copiedId === note.id;

              return (
                <div
                  key={note.id}
                  className={`group relative flex flex-col justify-between rounded-xl border p-5 shadow-sm transition hover:shadow-md ${colors.card}`}
                >
                  <div>
                    {/* Header: Category Badge + Pin Button + Sharing Pill */}
                    <div className="flex items-center justify-between gap-2 border-b pb-3" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${colors.badge}`}>
                          {note.category || 'General'}
                        </span>
                        {note.isPinned ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800" title="Pinned to top">
                            <Pin size={10} className="fill-amber-600 text-amber-700" /> Pinned
                          </span>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-1">
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => handleTogglePin(note)}
                            disabled={togglingPinId === note.id}
                            title={note.isPinned ? 'Unpin from top' : 'Pin to top'}
                            className={`rounded-md p-1 transition ${note.isPinned
                                ? 'text-amber-600 hover:bg-amber-100'
                                : 'text-[#8b9993] hover:bg-black/5 hover:text-[#2d3d37]'
                              }`}
                          >
                            <Pin size={13} className={note.isPinned ? 'fill-amber-500' : ''} />
                          </button>
                        )}

                        {note.isShared ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-[#e3f4e9] px-2 py-0.5 text-[10px] font-bold text-[#1f6643]"
                            title={isOwner ? 'Visible to everyone on your workspace team' : `Shared by ${note.authorName}`}
                          >
                            <Share2 size={10} />
                            {isOwner ? 'Shared with Team' : `Shared by ${note.authorName?.split(' ')[0] || 'Teammate'}`}
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600"
                            title="Private to you only"
                          >
                            <LockKeyhole size={10} /> Private
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Note Title */}
                    <h3 className="mt-3.5 font-display text-[16px] font-bold leading-snug tracking-tight text-[#22322d]">
                      {note.title}
                    </h3>

                    {/* Note Content preview (supports monospace/plain multiline) */}
                    <div className="mt-2.5 max-h-56 overflow-y-auto whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-[#495954]">
                      {note.content || <span className="italic text-[#92a09b]">No note content.</span>}
                    </div>
                  </div>

                  {/* Footer & Actions */}
                  <div className="mt-5 border-t pt-3.5" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
                    <div className="flex items-center justify-between text-[11px] text-[#788882]">
                      <span title={note.authorEmail}>
                        {note.authorName || 'Teammate'} · {new Date(note.updatedAt || note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>

                      <div className="flex items-center gap-1">
                        {/* Copy button */}
                        <button
                          type="button"
                          onClick={() => handleCopyContent(note)}
                          title="Copy note to clipboard"
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-[#5a6a65] transition hover:bg-black/5 hover:text-[#21312c]"
                        >
                          {isCopied ? (
                            <>
                              <Check size={12} className="text-[#28785b]" />
                              <span className="text-[#28785b]">Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy size={12} />
                              <span>Copy</span>
                            </>
                          )}
                        </button>

                        {/* Quick 1-click Share / Unshare Toggle */}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => handleToggleShare(note)}
                            disabled={togglingShareId === note.id}
                            title={note.isShared ? 'Make note private (only you)' : 'Share note with your workspace team'}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition ${note.isShared
                                ? 'bg-[#e2f1e8] text-[#226645] hover:bg-[#d4e9dc]'
                                : 'bg-black/5 text-[#556560] hover:bg-black/10 hover:text-[#22322d]'
                              }`}
                          >
                            <Share2 size={12} />
                            <span>{note.isShared ? 'Shared' : 'Share'}</span>
                          </button>
                        )}

                        {/* Edit Button */}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => openEditModal(note)}
                            title="Edit note"
                            className="rounded-md p-1.5 text-[#73837e] transition hover:bg-black/5 hover:text-[#22322d]"
                          >
                            <Pencil size={13} />
                          </button>
                        )}

                        {/* Delete Button */}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => handleDeleteNote(note)}
                            disabled={deletingId === note.id}
                            title="Delete note"
                            className="rounded-md p-1.5 text-[#ad544b] transition hover:bg-rose-100/70"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Create / Edit Note Modal */}
        {modalOpen && (
          <Dialog
            title={editingNote ? 'Edit Note' : 'Create Note or Scratchpad'}
            onClose={() => setModalOpen(false)}
            width="max-w-2xl"
          >
            <form onSubmit={handleSaveNote} className="space-y-4 p-5">
              <div>
                <label className="block text-[12px] font-bold text-[#354641]">
                  Note Title <span className="text-rose-500">*</span>
                  <input
                    type="text"
                    required
                    placeholder="E.g., Q4 Enterprise Outreach Strategy or Product Feedback Summary"
                    value={form.title}
                    onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3.5 py-2.5 text-[13px] text-[#2d3d38] outline-none transition focus:border-[#70a88c] focus:ring-2 focus:ring-[#28785b]/10"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-[12px] font-bold text-[#354641]">
                  Topic / Category
                  <select
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2 text-[13px] text-[#2d3d38] outline-none transition focus:border-[#70a88c]"
                  >
                    {categories.filter(c => c !== 'All Topics').map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>

                <div>
                  <label className="block text-[12px] font-bold text-[#354641]">
                    Color Accent
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    {[
                      { id: 'default', bg: 'bg-[#556360]', label: 'Default' },
                      { id: 'emerald', bg: 'bg-[#28785b]', label: 'Emerald' },
                      { id: 'amber', bg: 'bg-[#e59b20]', label: 'Amber' },
                      { id: 'blue', bg: 'bg-[#2b75be]', label: 'Blue' },
                      { id: 'purple', bg: 'bg-[#7a3dbf]', label: 'Purple' },
                      { id: 'rose', bg: 'bg-[#c53b30]', label: 'Rose' },
                    ].map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, color: c.id }))}
                        title={c.label}
                        className={`h-6 w-6 rounded-full transition ${c.bg} ${form.color === c.id ? 'ring-2 ring-black ring-offset-2' : 'opacity-70 hover:opacity-100'
                          }`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-bold text-[#354641]">
                  Note Content (Store anything)
                  <textarea
                    rows={8}
                    placeholder="Type or paste anything: meeting bullet points, strategies, scratch notes, code snippets, links, or follow-up checklists…"
                    value={form.content}
                    onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                    className="mt-1.5 w-full resize-y rounded-xl border border-[#dce5e0] bg-[#fbfcfb] p-3 text-[13px] leading-relaxed text-[#2d3d38] outline-none transition focus:border-[#70a88c] focus:ring-2 focus:ring-[#28785b]/10"
                  />
                </label>
              </div>

              {/* Privacy & Sharing Controls */}
              <div className="space-y-3 rounded-xl border border-[#e1e9e4] bg-[#f8faf9] p-4 text-[12px]">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={form.isShared}
                    onChange={e => setForm(f => ({ ...f, isShared: e.target.checked }))}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-[#28785b] focus:ring-[#28785b]"
                  />
                  <div>
                    <span className="font-bold text-[#253631]">Share this note with workspace team</span>
                    <p className="mt-0.5 text-[11px] text-[#63736e]">
                      {form.isShared
                        ? 'Active: Everyone in your workspace team will be able to see and learn from this note.'
                        : 'Disabled (Default): Strictly private to you. No teammate will see this note unless you enable sharing.'}
                    </p>
                  </div>
                </label>

                <label className="flex cursor-pointer items-start gap-3 border-t border-[#e8eeea] pt-2.5">
                  <input
                    type="checkbox"
                    checked={form.isPinned}
                    onChange={e => setForm(f => ({ ...f, isPinned: e.target.checked }))}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-[#28785b] focus:ring-[#28785b]"
                  />
                  <div>
                    <span className="font-bold text-[#253631]">Pin note to top</span>
                    <p className="mt-0.5 text-[11px] text-[#63736e]">
                      Keep this note pinned to the top of your dashboard and scratchpad for fast access.
                    </p>
                  </div>
                </label>
              </div>

              <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-4">
                <Btn kind="outline" onClick={() => setModalOpen(false)}>Cancel</Btn>
                <Btn type="submit" disabled={saving || !form.title.trim()}>
                  {saving ? 'Saving…' : editingNote ? 'Save Changes' : 'Create Note'}
                </Btn>
              </div>
            </form>
          </Dialog>
        )}
      </div>
    );
  }

  function SupportPage() {
    const isSuperAdmin = member?.role === 'super_admin';
    const [supportFilter, setSupportFilter] = useState<string>('all');
    const [supportType, setSupportType] = useState<string>('all');
    const [supportSearch, setSupportSearch] = useState<string>('');
    const [createOpen, setCreateOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [replyModal, setReplyModal] = useState<AnyRecord | null>(null);
    const [replyStatus, setReplyStatus] = useState<string>('Resolved');
    const [replyText, setReplyText] = useState<string>('');
    const [savingReply, setSavingReply] = useState(false);
    const [deletingTicketId, setDeletingTicketId] = useState<number | null>(null);

    const [ticketForm, setTicketForm] = useState({
      type: 'Suggestion',
      priority: 'Medium',
      subject: '',
      message: '',
    });

    const { data: ticketsList = [], isLoading, refetch } = useQuery<AnyRecord[]>({
      queryKey: ['speedmatch-support', supportFilter, supportType, supportSearch],
      queryFn: async () => {
        const params = new URLSearchParams();
        if (supportFilter && supportFilter !== 'all') params.set('status', supportFilter);
        if (supportType && supportType !== 'all') params.set('type', supportType);
        if (supportSearch) params.set('search', supportSearch);
        const res = await fetch(`/api/support/tickets?${params.toString()}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load tickets');
        return (await res.json()) as AnyRecord[];
      },
      refetchInterval: 10_000,
    });

    const handleCreateTicket = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!ticketForm.subject.trim() || !ticketForm.message.trim()) return;
      setSubmitting(true);
      try {
        const res = await fetch('/api/support/tickets', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ticketForm),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to submit ticket');
        }
        await refetch();
        setCreateOpen(false);
        setTicketForm({
          type: 'Suggestion',
          priority: 'Medium',
          subject: '',
          message: '',
        });
        setNotice({
          tone: 'good',
          text: 'Your submission has been sent directly to the Super Admin. You can track status and responses right here.',
        });
      } catch (err: any) {
        setNotice({ tone: 'bad', text: err.message || 'Could not submit ticket.' });
      } finally {
        setSubmitting(false);
      }
    };

    const openReplyModal = (ticket: AnyRecord) => {
      setReplyModal(ticket);
      setReplyStatus(ticket.status || 'Resolved');
      setReplyText(ticket.adminResponse || '');
    };

    const handleSaveReply = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!replyModal) return;
      setSavingReply(true);
      try {
        const res = await fetch(`/api/support/tickets/${replyModal.id}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: replyStatus,
            adminResponse: replyText.trim(),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to update ticket');
        }
        await refetch();
        setReplyModal(null);
        setNotice({
          tone: 'good',
          text: `Ticket #${replyModal.id} updated and response saved for ${replyModal.userName}.`,
        });
      } catch (err: any) {
        setNotice({ tone: 'bad', text: err.message || 'Could not update ticket.' });
      } finally {
        setSavingReply(false);
      }
    };

    const handleDeleteTicket = async (ticket: AnyRecord) => {
      if (!window.confirm(`Delete ticket #${ticket.id} (${ticket.subject})?`)) return;
      setDeletingTicketId(ticket.id);
      try {
        const res = await fetch(`/api/support/tickets/${ticket.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to delete ticket');
        }
        await refetch();
        setNotice({ tone: 'good', text: 'Ticket deleted.' });
      } catch (err: any) {
        setNotice({ tone: 'bad', text: err.message || 'Could not delete ticket.' });
      } finally {
        setDeletingTicketId(null);
      }
    };

    const getStatusBadge = (status: string) => {
      switch (status) {
        case 'Resolved':
          return (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#e3f5ea] px-2 py-0.5 text-[11px] font-bold text-[#1f6643]">
              <CheckCheck size={12} /> Resolved
            </span>
          );
        case 'In Review':
          return (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#e3eefc] px-2 py-0.5 text-[11px] font-bold text-[#1d5490]">
              <ActivityIcon size={12} /> In Review
            </span>
          );
        case 'Closed':
          return (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#f0f3f1] px-2 py-0.5 text-[11px] font-bold text-[#62716c]">
              Closed
            </span>
          );
        default:
          return (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#fff3db] px-2 py-0.5 text-[11px] font-bold text-[#8d5e16]">
              <Clock3 size={12} /> Pending Review
            </span>
          );
      }
    };

    const getTypeBadge = (type: string) => {
      const styles: Record<string, string> = {
        Suggestion: 'bg-[#e7f5ef] text-[#216747]',
        'Bug Report': 'bg-[#fdeeed] text-[#9b2a21]',
        'Feature Request': 'bg-[#f2ebfd] text-[#6329a1]',
        'Help / Question': 'bg-[#e7f0fa] text-[#1e528b]',
        Feedback: 'bg-[#eaf4f2] text-[#245f5a]',
      };
      return (
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold ${styles[type] || 'bg-gray-100 text-gray-700'}`}>
          {type}
        </span>
      );
    };

    const getPriorityBadge = (p: string) => {
      const styles: Record<string, string> = {
        Urgent: 'bg-rose-100 text-rose-800 font-bold',
        High: 'bg-amber-100 text-amber-800 font-bold',
        Medium: 'bg-slate-100 text-slate-700',
        Low: 'bg-slate-50 text-slate-500',
      };
      return (
        <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] ${styles[p] || 'bg-slate-100 text-slate-600'}`}>
          {p} Priority
        </span>
      );
    };

    // Calculate ticket stats
    const totalCount = ticketsList.length;
    const pendingCount = ticketsList.filter(t => t.status === 'Pending').length;
    const inReviewCount = ticketsList.filter(t => t.status === 'In Review').length;
    const resolvedCount = ticketsList.filter(t => t.status === 'Resolved').length;

    return (
      <div className="space-y-6">
        <PageHeader
          title={isSuperAdmin ? 'Support & Suggestions Hub (Super Admin)' : 'Support & Suggestions'}
          description={
            isSuperAdmin
              ? 'Central dispatch for all platform suggestions, bug reports, feature requests, and feedback submitted by workspace members.'
              : 'Direct communication line to the SpeedMatch Super Admin. Submit suggestions, report bugs, ask for help, or recommend features.'
          }
          action={
            <div className="flex items-center gap-3">
              <Btn onClick={() => setCreateOpen(true)}>
                <Plus size={15} /> Submit Suggestion or Report
              </Btn>
            </div>
          }
        />

        {/* Stats Row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">
              {isSuperAdmin ? 'Total System Tickets' : 'My Submissions'}
            </div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#23332e]">{totalCount}</div>
          </Card>
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">Pending Review</div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#d48817]">{pendingCount}</div>
          </Card>
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">In Review</div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#236bb5]">{inReviewCount}</div>
          </Card>
          <Card className="p-3.5">
            <div className="text-[11px] font-semibold text-[#73827d]">Resolved</div>
            <div className="mt-1 font-display text-[22px] font-bold text-[#28785b]">{resolvedCount}</div>
          </Card>
        </div>

        {/* Toolbar & Filters */}
        <div className="flex flex-col gap-3 rounded-xl border border-[#e2e9e5] bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          {/* Status Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'all', label: 'All Statuses' },
              { id: 'Pending', label: 'Pending', count: pendingCount },
              { id: 'In Review', label: 'In Review', count: inReviewCount },
              { id: 'Resolved', label: 'Resolved', count: resolvedCount },
              { id: 'Closed', label: 'Closed' },
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSupportFilter(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${supportFilter === tab.id
                    ? 'bg-[#28785b] text-white shadow-sm'
                    : 'bg-[#f4f7f5] text-[#556560] hover:bg-[#e9eee9]'
                  }`}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span className={`rounded-full px-1.5 py-0.2 text-[10px] ${supportFilter === tab.id ? 'bg-white/25 text-white' : 'bg-black/5 text-[#6a7974]'}`}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Type dropdown & Search */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={supportType}
              onChange={e => setSupportType(e.target.value)}
              className="rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-1.5 text-[12px] text-[#2d3d38] outline-none"
            >
              <option value="all">All Types</option>
              <option value="Suggestion">Suggestions</option>
              <option value="Bug Report">Bug Reports</option>
              <option value="Feature Request">Feature Requests</option>
              <option value="Help / Question">Help / Questions</option>
              <option value="Feedback">Feedback</option>
            </select>

            <div className="relative min-w-[200px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8b9993]" />
              <input
                type="text"
                placeholder="Search tickets, subject…"
                value={supportSearch}
                onChange={e => setSupportSearch(e.target.value)}
                className="w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] py-1.5 pl-9 pr-3 text-[12px] text-[#2f3f3a] outline-none transition focus:border-[#70a88c]"
              />
            </div>
          </div>
        </div>

        {/* Tickets List */}
        {isLoading ? (
          <LoadingRows />
        ) : ticketsList.length === 0 ? (
          <Card className="mx-auto max-w-lg p-10 text-center">
            <Empty
              title={isSuperAdmin ? 'No tickets to review' : 'No suggestions or reports yet'}
              detail={
                isSuperAdmin
                  ? 'All user suggestions, reports, and questions have been processed or none match the selected filter.'
                  : 'Have an idea to improve the platform or found an issue? Submit a ticket and the Super Admin will review it.'
              }
              button={
                <Btn onClick={() => setCreateOpen(true)}>
                  <Plus size={14} /> Submit a suggestion or report
                </Btn>
              }
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {ticketsList.map(ticket => {
              const isAuthor = ticket.userId === member?.id;
              const canDelete = isAuthor || isSuperAdmin;

              return (
                <Card key={ticket.id} className="p-5 transition hover:border-[#b8d4c5]">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] font-bold text-[#71817c]">
                          #TKT-{ticket.id}
                        </span>
                        {getTypeBadge(ticket.type)}
                        {getPriorityBadge(ticket.priority)}
                        {getStatusBadge(ticket.status)}
                      </div>

                      <h3 className="font-display text-[16px] font-bold text-[#23332e]">
                        {ticket.subject}
                      </h3>

                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#788882]">
                        <span className="font-semibold text-[#40504b]">{ticket.userName}</span>
                        <span>({ticket.userEmail})</span>
                        {ticket.companyName && (
                          <>
                            <span>·</span>
                            <span className="inline-flex items-center gap-1 text-[#28785b]">
                              <Building2 size={11} /> {ticket.companyName}
                            </span>
                          </>
                        )}
                        <span>·</span>
                        <span>{new Date(ticket.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2">
                      {isSuperAdmin && (
                        <Btn kind="soft" onClick={() => openReplyModal(ticket)}>
                          <MessageSquareText size={13} /> {ticket.adminResponse ? 'Update Response' : 'Reply & Update Status'}
                        </Btn>
                      )}

                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => handleDeleteTicket(ticket)}
                          disabled={deletingTicketId === ticket.id}
                          title="Delete ticket"
                          className="rounded-lg p-2 text-[#b05247] transition hover:bg-rose-50"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Ticket message content */}
                  <div className="mt-3.5 rounded-lg border border-[#e8ecea] bg-[#fafcfb] p-3.5 text-[13px] leading-relaxed text-[#354641] whitespace-pre-wrap font-sans">
                    {ticket.message}
                  </div>

                  {/* Super Admin Response Section */}
                  {ticket.adminResponse ? (
                    <div className="mt-3.5 rounded-xl border border-[#c4e4d1] bg-[#edf8f2] p-4 text-[12px] text-[#1c4e38]">
                      <div className="flex items-center justify-between font-bold text-[#1a553a]">
                        <span className="flex items-center gap-1.5">
                          <ShieldCheck size={14} className="text-[#28785b]" />
                          Official Super Admin Response
                        </span>
                        {ticket.respondedAt && (
                          <span className="text-[10px] font-normal text-[#4c7b64]">
                            {new Date(ticket.respondedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-[#224e3a]">
                        {ticket.adminResponse}
                      </p>
                    </div>
                  ) : (
                    <div className="mt-3 text-[11px] text-[#80908b] italic">
                      Awaiting review & response from Super Admin.
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* Modal: Submit Suggestion / Report */}
        {createOpen && (
          <Dialog
            title="Submit Suggestion, Bug, or Feedback"
            onClose={() => setCreateOpen(false)}
            width="max-w-xl"
          >
            <form onSubmit={handleCreateTicket} className="space-y-4 p-5">
              <div className="rounded-lg border border-[#d6e7dc] bg-[#f2f8f4] p-3.5 text-[12px] text-[#2c5841]">
                Your submission will be routed directly to the <strong>Super Admin</strong>. You will receive official status updates and responses right here on your support dashboard.
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-[12px] font-bold text-[#354641]">
                  Submission Type
                  <select
                    value={ticketForm.type}
                    onChange={e => setTicketForm(f => ({ ...f, type: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2 text-[13px] text-[#2d3d38] outline-none transition focus:border-[#70a88c]"
                  >
                    <option value="Suggestion">Suggestion (Idea to improve platform)</option>
                    <option value="Bug Report">Bug Report (Something is broken)</option>
                    <option value="Feature Request">Feature Request (New functionality)</option>
                    <option value="Help / Question">Help / Question (How-to or question)</option>
                    <option value="Feedback">General Feedback</option>
                  </select>
                </label>

                <label className="block text-[12px] font-bold text-[#354641]">
                  Priority
                  <select
                    value={ticketForm.priority}
                    onChange={e => setTicketForm(f => ({ ...f, priority: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2 text-[13px] text-[#2d3d38] outline-none transition focus:border-[#70a88c]"
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Urgent">Urgent</option>
                  </select>
                </label>
              </div>

              <div>
                <label className="block text-[12px] font-bold text-[#354641]">
                  Subject <span className="text-rose-500">*</span>
                  <input
                    type="text"
                    required
                    placeholder="Brief summary of your suggestion or issue"
                    value={ticketForm.subject}
                    onChange={e => setTicketForm(f => ({ ...f, subject: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3.5 py-2.5 text-[13px] text-[#2d3d38] outline-none transition focus:border-[#70a88c]"
                  />
                </label>
              </div>

              <div>
                <label className="block text-[12px] font-bold text-[#354641]">
                  Description & Details <span className="text-rose-500">*</span>
                  <textarea
                    required
                    rows={5}
                    placeholder="Provide details: what you want to see improved, steps to reproduce a bug, or questions for the Super Admin…"
                    value={ticketForm.message}
                    onChange={e => setTicketForm(f => ({ ...f, message: e.target.value }))}
                    className="mt-1.5 w-full resize-y rounded-xl border border-[#dce5e0] bg-[#fbfcfb] p-3 text-[13px] leading-relaxed text-[#2d3d38] outline-none transition focus:border-[#70a88c]"
                  />
                </label>
              </div>

              <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-4">
                <Btn kind="outline" onClick={() => setCreateOpen(false)}>Cancel</Btn>
                <Btn type="submit" disabled={submitting || !ticketForm.subject.trim() || !ticketForm.message.trim()}>
                  <Send size={14} /> {submitting ? 'Submitting…' : 'Submit to Super Admin'}
                </Btn>
              </div>
            </form>
          </Dialog>
        )}

        {/* Modal: Super Admin Reply & Status Change */}
        {replyModal && (
          <Dialog
            title={`Reply to Ticket #${replyModal.id} — ${replyModal.subject}`}
            onClose={() => setReplyModal(null)}
            width="max-w-xl"
          >
            <form onSubmit={handleSaveReply} className="space-y-4 p-5">
              <div className="rounded-lg border border-[#d6e7dc] bg-[#f2f8f4] p-3 text-[12px] text-[#2c5841]">
                Replying to <strong>{replyModal.userName}</strong> ({replyModal.userEmail}) from <strong>{replyModal.companyName || 'Workspace'}</strong>.
              </div>

              <div>
                <label className="block text-[12px] font-bold text-[#354641]">
                  Update Status
                  <select
                    value={replyStatus}
                    onChange={e => setReplyStatus(e.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-[#dce5e0] bg-[#fbfcfb] px-3 py-2 text-[13px] text-[#2d3d38] outline-none focus:border-[#70a88c]"
                  >
                    <option value="Pending">Pending</option>
                    <option value="In Review">In Review</option>
                    <option value="Resolved">Resolved</option>
                    <option value="Closed">Closed</option>
                  </select>
                </label>
              </div>

              <div>
                <label className="block text-[12px] font-bold text-[#354641]">
                  Super Admin Official Response
                  <textarea
                    rows={6}
                    placeholder="Write your official response to the user. They will see this prominently on their support dashboard."
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    className="mt-1.5 w-full resize-y rounded-xl border border-[#dce5e0] bg-[#fbfcfb] p-3 text-[13px] text-[#2d3d38] outline-none focus:border-[#70a88c]"
                  />
                </label>
              </div>

              <div className="flex justify-end gap-2 border-t border-[#edf0ee] pt-4">
                <Btn kind="outline" onClick={() => setReplyModal(null)}>Cancel</Btn>
                <Btn type="submit" disabled={savingReply}>
                  {savingReply ? 'Saving…' : 'Save Response & Update Status'}
                </Btn>
              </div>
            </form>
          </Dialog>
        )}
      </div>
    );
  }

  let content: ReactNode;
  switch (path) {
    case '/dashboard': content = member?.role === 'super_admin' ? <Redirect to="/super-admin" /> : <Dashboard />; break;
    case '/contacts': content = member?.role === 'super_admin' ? <Redirect to="/super-admin" /> : <ResourcePage entity="contacts" />; break;
    case '/companies': content = !isAdmin ? <Redirect to="/dashboard" /> : <ResourcePage entity="companies" />; break;
    case '/deals': content = member?.role === 'super_admin' ? <Redirect to="/super-admin" /> : <ResourcePage entity="deals" />; break;
    case '/tasks': content = <ResourcePage entity="tasks" />; break;
    case '/notes': content = <NotesPage />; break;
    case '/analytics': content = <Redirect to={member?.role === 'super_admin' ? '/super-admin' : '/dashboard'} />; break;
    case '/team': content = member?.role === 'super_admin' ? <Redirect to="/super-admin" /> : <Team />; break;
    case '/inbox': content = member?.role === 'super_admin' ? <Redirect to="/super-admin" /> : <InboxPage />; break;
    case '/community': content = <Community />; break;
    case '/support': content = <SupportPage />; break;
    case '/super-admin': content = <SuperAdminPage />; break;
    default: content = member?.role === 'super_admin' ? <Redirect to="/super-admin" /> : <NotFound />;
  }
  if (!approved && member?.role !== 'super_admin') return <AppShell path={path} member={member}><Card className="mt-16 mx-auto max-w-lg"><Empty title="Checking workspace access" detail="Your membership is still being confirmed. CRM data remains private until access is approved." button={<Btn kind="outline" onClick={() => window.location.reload()}><RotateCw size={14} /> Check status</Btn>} /></Card></AppShell>;
  return <AppShell path={path} member={member}><div className="fade-in">{failed && <NoticeBar notice={{ tone: 'bad', text: 'Some workspace data could not be loaded. Retry the section below.' }} clear={() => qs.forEach((q: any) => q.refetch())} />}{content}</div>{modal && <RecordDialog entity={modal.entity} initial={modal.row} onClose={() => setModal(null)} onSave={data => saveResource(modal.entity, data)} busy={allPending} />}</AppShell>;
}

function MemberGate({ path }: { path: string }) {
  const { isLoaded, member } = useAuth();
  if (!isLoaded) return <div className="grid min-h-[100dvh] place-items-center bg-[#f6f8f7]"><div className="flex items-center gap-3 rounded-xl border border-[#e3e9e5] bg-white px-5 py-4 text-[12px] text-[#71807a]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#599570]" /> Preparing your workspace…</div></div>;
  if (!member) return <Redirect to="/sign-in" />;
  if (member.role !== 'super_admin' && member.status !== 'active') {
    return <UnauthorizedGate member={member} />;
  }
  return <Workspace path={path} member={member} />;
}

function HomeRedirect() {
  const { isLoaded, member } = useAuth();
  if (isLoaded && member) return <Redirect to={member.role === 'super_admin' ? '/super-admin' : '/dashboard'} />;
  return <Landing />;
}
function ProtectedRoute({ path }: { path: string }) { return <MemberGate path={path} />; }
function RouterContent() {
  return <Switch>
    <Route path="/" component={HomeRedirect} />
    <Route path="/sign-in/*?" component={SignInPage} />
    <Route path="/sign-up/*?" component={SignUpPage} />
    <Route path="/super-admin"><ProtectedRoute path="/super-admin" /></Route>
    {navGroups.flatMap(g => g.items).map(item => <Route key={item.href} path={item.href}><ProtectedRoute path={item.href} /></Route>)}
    <Route component={NotFound} />
  </Switch>;
}

function ClerkWrapper({ children }: { children: ReactNode }) {
  const { clerkKey } = useAuth();
  if (clerkKey && clerkKey.startsWith('pk_')) {
    return (
      <ClerkProvider publishableKey={clerkKey}>
        <ClerkSyncBridge />
        {children}
      </ClerkProvider>
    );
  }
  return <>{children}</>;
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <ClerkWrapper>
            <RouterContent />
            <SuperAdminModal />
          </ClerkWrapper>
        </AuthProvider>
      </QueryClientProvider>
    </WouterRouter>
  );
}
export default App;
