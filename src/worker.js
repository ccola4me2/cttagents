// Trip Vara advisor portal Worker.
//
// Routes the JSON API, gates the portal pages behind a session (and /admin
// behind the admin role), and serves the static files in ./public.
//
// [assets] run_worker_first = true in wrangler.toml is what makes the gate
// real: every request lands here first, and protected HTML is only served
// after the session check passes.

import { redirect, notFound, json } from './util.js';
import {
  handleSignup, handleLogin, handleLogout, handleMe,
  handleForgot, handleReset, handleChangePassword, handleUpdateProfile,
  getCurrentUser, isAdmin,
} from './auth.js';
import {
  handleListLeads, handleGetLead, handleCreateLead, handleUpdateLead, handleCreateLeadNote,
  handleContactDetail, handleCreateTask, handleToggleTask,
} from './leads.js';
import {
  handleListPipelines, handleListOpportunities,
  handleCreateOpportunity, handleUpdateOpportunity,
} from './pipeline.js';
import {
  handleListBookings, handleGetBooking, handleBookingRecord, handleCreateBooking,
  handleUpdateBooking, handleQuickUpdate, handleDeleteBooking, handleWelcomed,
} from './bookings.js';
import { markReturnedTripsTravelled } from './db.js';
import { mirrorCatalogStep } from './catalogmirror.js';
import { remindTasks } from './taskmail.js';
import { remindDuePayments } from './payremind.js';
import { sendCallLists } from './calllist.js';
import {
  handleShareTrip, handleShareDocument, handleTripMessages, handleReadTripMessage,
  renderTripPage, handleTripMessage, serveTripDocument,
} from './share.js';
import { handleReadConfirmation } from './confirm.js';
import { migrationHint } from './schema-drift.js';
import {
  handleAddComponent, handleUpdateComponent, handleDeleteComponent,
} from './components.js';
import {
  handleUploadDocument, handleGetDocument, handleDeleteDocument,
} from './documents.js';
import { handleStatement } from './statement.js';
import {
  handleAddOption, handleUpdateOption, handleDeleteOption, handleChooseOption,
} from './options.js';
import {
  handleListTiers, handleAddTier, handleUpdateTier, handleDeleteTier, handleApplyVendorTerms,
} from './penalties.js';
import {
  handleListConversations, handleListMessages as handleConversationMessages, handleSendMessage,
} from './conversations.js';
import { handleListCalendar, handleCreateAppointment } from './calendar.js';
import { handleBilling, handleCreateInvoice, handleSendInvoice } from './billing.js';
import {
  handlePayments, handleCreatePayment, handlePaymentReminder, handleUpdatePayment,
  handleMarkPaid, handleDeletePayment, handleGenerateSchedule, handleSetBookingStatus,
} from './payments.js';
import {
  handleListForms, handleListWorkflows, handleAddToWorkflow, handleListCampaigns,
} from './forms.js';
import { handleCrmLinks } from './crm.js';
import {
  handleListForms as handleListOwnForms, handleGetForm, handleSaveForm, handleDeleteForm,
  handleFormsReport, handleReservationFromLead,
} from './formbuilder.js';
import {
  renderPublicForm, handlePublicSubmit, renderGroupPage, handleGroupRegistration,
  renderSpecialPage, handleSpecialEnquiry,
} from './publicform.js';
import { handleSearch } from './search.js';
import { handleGetLayout, handleSaveLayout, handleResetLayout } from './prefs.js';
// Aliased: leads.js already exports handleCreateTask for the CRM's own
// contact tasks, which are a different thing from an advisor's working list.
import {
  handleListTasks as handleListMyTasks,
  handleCreateTask as handleCreateMyTask,
  handleUpdateTask as handleUpdateMyTask,
  handleDeleteTask as handleDeleteMyTask,
  handleListTaskItems, handleCreateTaskItem, handleUpdateTaskItem, handleDeleteTaskItem,
} from './tasks.js';
import {
  handleListTemplates, handleSaveTemplate, handleDeleteTemplate, handleSeedTemplates,
} from './tasktemplates.js';
import {
  handleListGroups, handleGetGroup, handleBookRegistration, handleCreateGroup, handleUpdateGroup, handleDeleteGroup,
} from './groups.js';
import {
  handleListCredits, handleCreateCredit, handleUpdateCredit, handleDeleteCredit,
} from './credits.js';
import {
  handleHotLists, handleHotListDone, handleHotListUndo,
} from './hotlists.js';
import {
  handleListSpecials, handleGetSpecial, handleCreateSpecial, handleUpdateSpecial,
  handleDeleteSpecial, handleBookEnquiry, handleDeleteEnquiry,
} from './specials.js';
import { handleGetGoals, handleSaveGoals } from './goals.js';
import { handleListCommissions, handleSetCommissionStatus } from './commissions.js';
import {
  handleListReceipts, handleAddReceipt, handleDeleteReceipt,
  handleListStatements, handleCreateStatement, handleUpdateStatement,
  handleDeleteStatement, handleStatementCandidates,
} from './reconcile.js';
import { handleClientRecord, handleListClients, handleUpdateClient } from './clients.js';
import { handlePreviewImport, handleRunImport } from './importer.js';
import {
  handleCatalogLines, handleCatalogSearch, handleCatalogSailing, handleCatalogShips, handleCatalogDates, handleCatalogStatus,
  handleCatalogImport, handleCatalogSuggest, handleCatalogApply,
} from './catalogapi.js';
import { importCatalogStep } from './catalog.js';
import {
  handleListVendors, handleUpdateVendor, handleMergeVendors, handleSuggestDates,
  handleFavouriteVendor, handleCreateVendor, handleDeleteVendor, handleImportVendors,
  handleGetVendor,
} from './vendors.js';
import {
  handleAddTraveller, handleUpdateTraveller, handleDeleteTraveller,
  handleAddAmenity, handleUpdateAmenity, handleDeleteAmenity,
  handleDocumentWatch,
} from './travellers.js';
import {
  handleAddPriceLine, handleUpdatePriceLine, handleDeletePriceLine, handleSavePricingGrid,
} from './pricing.js';
import {
  handleListAutomations, handleGetAutomation, handleSaveAutomation,
  handleDeleteAutomation, handleRunAutomations, processDueRuns, scanTimeTriggers, purgeOldRuns,
} from './automations.js';
import {
  handleMarketing, handleCatalog, handleLibrary, handleAccount, handleSurveys, handleUploadMedia,
  handleCreateSocialPost, handleCreateProduct, handleCreateAccountItem,
} from './library.js';
import { handleDashboard, handleProduction, handleMonth } from './reports.js';
import {
  handleListAdvisors, handleSetAdvisorStatus, handleSetAdvisorGhl, handleSetAdvisorSplit,
  handleRunLifecycle,
  handleHealth, handleTestEmail, handleRunTaskReminders, handleRunPaymentReminders,
  handleRunCallLists, handleMirrorCatalog, handleMirrorStatus,
  handleSyncStatus, handleRunSync,
} from './admin.js';
import { purgeExpiredSessions } from './db.js';
import { runSync } from './sync.js';
import { locationFor } from './ghl.js';

// Pages any visitor may reach.
const PUBLIC_PAGES = new Set([
  '/', '/index.html',
  '/login', '/login.html',
  '/signup', '/signup.html',
  '/forgot-password', '/forgot-password.html',
  '/reset-password', '/reset-password.html',
  '/pending', '/pending.html',
]);

// Extension-less page paths mapped to the file that serves them.
const PAGE_FILES = {
  '/': '/index.html',
  '/login': '/login.html',
  '/signup': '/signup.html',
  '/forgot-password': '/forgot-password.html',
  '/reset-password': '/reset-password.html',
  '/pending': '/pending.html',
  '/app': '/app/index.html',
  '/app/': '/app/index.html',
  '/app/leads': '/app/leads.html',
  '/app/contact': '/app/contact.html',
  '/app/inbox': '/app/inbox.html',
  '/app/calendar': '/app/calendar.html',
  '/app/billing': '/app/billing.html',
  '/app/payments': '/app/payments.html',
  '/app/forms': '/app/forms.html',
  '/app/formbuilder': '/app/formbuilder.html',
  '/app/automations': '/app/automations.html',
  '/app/crm': '/app/crm.html',
  '/app/marketing': '/app/marketing.html',
  '/app/catalog': '/app/catalog.html',
  '/app/library': '/app/library.html',
  '/app/account': '/app/account.html',
  '/app/pipeline': '/app/pipeline.html',
  '/app/tasks': '/app/tasks.html',
  '/app/new': '/app/new.html',
  '/app/groups': '/app/groups.html',
  '/app/credits': '/app/credits.html',
  '/app/hotlists': '/app/hotlists.html',
  '/app/specials': '/app/specials.html',
  '/app/special': '/app/special.html',
  '/app/goals': '/app/goals.html',
  '/app/commissions': '/app/commissions.html',
  '/app/reservations': '/app/reservations.html',
  '/app/reservation': '/app/reservation.html',
  '/app/client': '/app/client.html',
  '/app/clients': '/app/clients.html',
  '/app/import': '/app/import.html',
  '/app/complete': '/app/complete.html',
  '/app/vendors': '/app/vendors.html',
  '/app/vendor': '/app/vendor.html',
  '/app/group': '/app/group.html',
  '/app/cruise-search': '/app/cruise-search.html',
  '/app/form': '/app/form.html',
  '/app/bookings': '/app/reservations.html',
  '/app/reports': '/app/reports.html',
  '/app/settings': '/app/settings.html',
  '/admin': '/admin/index.html',
  '/admin/': '/admin/index.html',
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx);
    } catch (e) {
      // Say what happened and where. This returned "Something went wrong."
      // and nothing else, which is how a 500 on the Payments page cost most
      // of a day: the page showed the server's own shrug, I read it as the
      // client giving up, and there was nothing on either side to read.
      //
      // Everything behind this router needs a session, so the reader is an
      // advisor rather than the internet. Handing a trusted user the message
      // and the path is worth more than withholding it from them, and the
      // message is capped in case a driver ever puts a row in one.
      const path = new URL(request.url).pathname;
      const detail = String((e && e.message) || e).slice(0, 200);
      console.error('unhandled', path, e);
      // A correct query against a database that has not had every migration
      // applied fails exactly like a bug in the code. Say which it is, and
      // which file fixes it, rather than leaving that to be worked out.
      const hint = migrationHint(detail);
      return json({ error: `${path} failed: ${detail}`, ...(hint ? { hint } : {}) }, 500);
    }
  },

  // Keeps the local CRM copy current and drops expired sessions. Both are
  // resumable or cheap, so an idle run costs almost nothing.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpiredSessions(env).catch((e) => console.error('purge', e)));
    ctx.waitUntil(purgeOldRuns(env).catch((e) => console.error('purge runs', e)));
    ctx.waitUntil(
      runSync(env, locationFor(env, null)).catch((e) => console.error('sync', e))
    );
    // Look for time based triggers, then advance whatever is due. Order
    // matters: scanning first means a payment that just came into range is
    // acted on in the same pass rather than waiting five more minutes.
    // The catalog import is a no-op once the current monthly snapshot is fully
    // imported, so running it on every tick costs one request a day and the
    // catalog is never more than five minutes behind a new snapshot.
    ctx.waitUntil(
      importCatalogStep(env, { maxPages: 8 }).catch((e) => console.error('catalog import', e))
    );
    // Without a feed key of its own, the catalog is mirrored from the copy
    // CruiseShoppers already holds. A finished pass costs one request, so this
    // is cheap on the ticks where there is nothing to do.
    ctx.waitUntil(
      mirrorCatalogStep(env, { maxShips: 8 }).catch((e) => console.error('catalog mirror', e))
    );
    // A trip whose return date has passed has been travelled. Nothing else
    // ever set that status, so the reports said nobody had been anywhere.
    ctx.waitUntil(
      markReturnedTripsTravelled(env, { today: new Date().toISOString().slice(0, 10) })
        .catch((e) => console.error('lifecycle', e))
    );
    // What is due today and what is late, once a day. A no-op before the hour
    // and for any task already told about, so running it every five minutes
    // costs one query on almost every tick.
    ctx.waitUntil(remindTasks(env).catch((e) => console.error('task reminders', e)));
    // And the client side of the same idea: the money is due on a date, and
    // the advisor pressing send is the part that does not scale. Only for
    // advisors who turned it on, and only on real vendor deadlines.
    ctx.waitUntil(
      remindDuePayments(env).catch((e) => console.error('payment reminders', e))
    );
    // And once a week, the calls nothing else is chasing anybody about. A
    // no-op on six days in seven, so this costs one query on almost every tick.
    ctx.waitUntil(sendCallLists(env).catch((e) => console.error('call lists', e)));
    ctx.waitUntil(
      scanTimeTriggers(env, locationFor(env, null))
        .catch((e) => console.error('time triggers', e))
        .then(() => processDueRuns(env))
        .catch((e) => console.error('automations', e))
    );
  },
};

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const method = request.method.toUpperCase();

  if (path.startsWith('/api/')) return routeApi(request, env, path, method);

  // Everything else is a page or a static file.
  return routePage(request, env, path);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function routeApi(request, env, path, method) {
  // /api/leads/<id>/notes and /api/leads/<id>
  const leadMatch = path.match(/^\/api\/leads\/([^/]+)(\/notes)?$/);
  const detailMatch = path.match(/^\/api\/leads\/([^/]+)\/detail$/);
  const taskMatch = path.match(/^\/api\/leads\/([^/]+)\/tasks(?:\/([^/]+))?$/);
  const wfMatch = path.match(/^\/api\/leads\/([^/]+)\/workflow$/);
  const oppMatch = path.match(/^\/api\/opportunities\/([^/]+)$/);
  const bookingMatch = path.match(/^\/api\/bookings\/([^/]+)$/);
  const recordMatch = path.match(/^\/api\/bookings\/([^/]+)\/record$/);
  const quickMatch = path.match(/^\/api\/bookings\/([^/]+)\/quick$/);
  const statementMatch = path.match(/^\/api\/bookings\/([^/]+)\/statement$/);
  const welcomedMatch = path.match(/^\/api\/bookings\/([^/]+)\/welcomed$/);
  const shareMatch = path.match(/^\/api\/bookings\/([^/]+)\/share$/);
  const tripMsgMatch = path.match(/^\/api\/bookings\/([^/]+)\/messages$/);
  const msgReadMatch = path.match(/^\/api\/trip-messages\/([^/]+)\/read$/);
  const docShareMatch = path.match(/^\/api\/documents\/([^/]+)\/share$/);
  const docsMatch = path.match(/^\/api\/bookings\/([^/]+)\/documents$/);
  const componentsMatch = path.match(/^\/api\/bookings\/([^/]+)\/components$/);
  const componentMatch = path.match(/^\/api\/components\/([^/]+)$/);
  const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
  const travellersMatch = path.match(/^\/api\/bookings\/([^/]+)\/travellers$/);
  const amenitiesMatch = path.match(/^\/api\/bookings\/([^/]+)\/amenities$/);
  const travellerMatch = path.match(/^\/api\/travellers\/([^/]+)$/);
  const amenityMatch = path.match(/^\/api\/amenities\/([^/]+)$/);
  const pricingMatch = path.match(/^\/api\/bookings\/([^/]+)\/pricing$/);
  const optionsMatch = path.match(/^\/api\/bookings\/([^/]+)\/options$/);
  const optionMatch = path.match(/^\/api\/options\/([^/]+)$/);
  const chooseMatch = path.match(/^\/api\/options\/([^/]+)\/choose$/);
  const tierMatch = path.match(/^\/api\/penalties\/([^/]+)$/);
  const applyTermsMatch = path.match(/^\/api\/bookings\/([^/]+)\/penalties\/apply$/);
  const priceLineMatch = path.match(/^\/api\/pricing\/([^/]+)$/);
  const convoMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  const invoiceSendMatch = path.match(/^\/api\/billing\/invoices\/([^/]+)\/send$/);
  const ownFormMatch = path.match(/^\/api\/myforms\/([^/]+)$/);
  const leadToBookingMatch = path.match(/^\/api\/leads\/submissions\/([^/]+)\/reservation$/);
  const publicFormMatch = path.match(/^\/api\/public\/forms\/([^/]+)$/);
  // Excludes /run, which is an action rather than an automation id.
  const accountItemMatch = path.match(/^\/api\/account\/(tags|custom-values|custom-fields)$/);
  const autoMatch = path.match(/^\/api\/automations\/(?!run$)([^/]+)$/);
  const payMatch = path.match(/^\/api\/payments\/([^/]+)$/);
  const payPaidMatch = path.match(/^\/api\/payments\/([^/]+)\/paid$/);
  const payRemindMatch = path.match(/^\/api\/payments\/([^/]+)\/remind$/);
  const scheduleMatch = path.match(/^\/api\/bookings\/([^/]+)\/schedule$/);
  const bookingStatusMatch = path.match(/^\/api\/bookings\/([^/]+)\/status$/);
  const advisorMatch = path.match(/^\/api\/admin\/advisors\/([^/]+)\/(status|ghl|split)$/);
  const myTaskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  // Checklist steps hang off a task; the steps themselves are addressed by
  // their own id, so ticking one off does not need to name its task twice.
  const taskItemsMatch = path.match(/^\/api\/tasks\/([^/]+)\/items$/);
  const taskItemMatch = path.match(/^\/api\/task-items\/([^/]+)$/);
  const templateMatch = path.match(/^\/api\/task-templates\/([^/]+)$/);
  const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
  const groupBookMatch = path.match(/^\/api\/groups\/registrations\/([^/]+)\/book$/);
  const creditMatch = path.match(/^\/api\/credits\/([^/]+)$/);
  const specialMatch = path.match(/^\/api\/specials\/([^/]+)$/);
  const enquiryBookMatch = path.match(/^\/api\/specials\/enquiries\/([^/]+)\/book$/);
  const enquiryMatch = path.match(/^\/api\/specials\/enquiries\/([^/]+)$/);
  const receiptMatch = path.match(/^\/api\/commissions\/receipts\/([^/]+)$/);
  const vendorStatementMatch = path.match(/^\/api\/commissions\/statements\/([^/]+)$/);
  const candidatesMatch = path.match(/^\/api\/commissions\/statements\/([^/]+)\/candidates$/);
  const clientMatch = path.match(/^\/api\/clients\/([^/]+)$/);
  const vendorMatch = path.match(/^\/api\/vendors\/([^/]+)$/);
  const vendorStarMatch = path.match(/^\/api\/vendors\/([^/]+)\/favourite$/);

  // ---- auth -------------------------------------------------------------
  if (path === '/api/auth/signup' && method === 'POST') return handleSignup(request, env);
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
  if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
  if (path === '/api/auth/forgot' && method === 'POST') return handleForgot(request, env);
  if (path === '/api/auth/reset' && method === 'POST') return handleReset(request, env);
  if (path === '/api/auth/password' && method === 'POST') return handleChangePassword(request, env);
  if (path === '/api/auth/profile' && method === 'PUT') return handleUpdateProfile(request, env);

  // ---- leads ------------------------------------------------------------
  if (path === '/api/leads' && method === 'GET') return handleListLeads(request, env);
  if (path === '/api/leads' && method === 'POST') return handleCreateLead(request, env);
  if (wfMatch && method === 'POST') {
    return handleAddToWorkflow(request, env, decodeURIComponent(wfMatch[1]));
  }
  if (detailMatch && method === 'GET') {
    return handleContactDetail(request, env, decodeURIComponent(detailMatch[1]));
  }
  if (taskMatch && !taskMatch[2] && method === 'POST') {
    return handleCreateTask(request, env, decodeURIComponent(taskMatch[1]));
  }
  if (taskMatch && taskMatch[2] && method === 'PUT') {
    return handleToggleTask(request, env,
      decodeURIComponent(taskMatch[1]), decodeURIComponent(taskMatch[2]));
  }
  if (leadMatch && leadMatch[2] === '/notes' && method === 'POST') {
    return handleCreateLeadNote(request, env, decodeURIComponent(leadMatch[1]));
  }
  if (leadMatch && !leadMatch[2] && method === 'GET') {
    return handleGetLead(request, env, decodeURIComponent(leadMatch[1]));
  }
  if (leadMatch && !leadMatch[2] && method === 'PUT') {
    return handleUpdateLead(request, env, decodeURIComponent(leadMatch[1]));
  }

  // ---- pipeline ---------------------------------------------------------
  if (path === '/api/pipelines' && method === 'GET') return handleListPipelines(request, env);
  if (path === '/api/opportunities' && method === 'GET') return handleListOpportunities(request, env);
  if (path === '/api/opportunities' && method === 'POST') return handleCreateOpportunity(request, env);
  if (oppMatch && method === 'PUT') {
    return handleUpdateOpportunity(request, env, decodeURIComponent(oppMatch[1]));
  }

  // ---- bookings ---------------------------------------------------------
  if (path === '/api/bookings' && method === 'GET') return handleListBookings(request, env);
  if (path === '/api/bookings' && method === 'POST') return handleCreateBooking(request, env);
  if (recordMatch && method === 'GET') return handleBookingRecord(request, env, recordMatch[1]);
  if (quickMatch && method === 'POST') return handleQuickUpdate(request, env, quickMatch[1]);
  // What the client is told, which is a narrow subset of what the record holds.
  if (statementMatch && method === 'POST') return handleStatement(request, env, statementMatch[1]);
  if (welcomedMatch && method === 'POST') return handleWelcomed(request, env, welcomedMatch[1]);

  // The paperwork a trip generates. Inert until an R2 bucket is bound.
  // One trip, several vendors: air, insurance, lodging, a transfer.
  if (componentsMatch && method === 'POST') return handleAddComponent(request, env, componentsMatch[1]);
  if (componentMatch && method === 'PUT') return handleUpdateComponent(request, env, componentMatch[1]);
  if (componentMatch && method === 'DELETE') return handleDeleteComponent(request, env, componentMatch[1]);

  if (docsMatch && method === 'POST') return handleUploadDocument(request, env, docsMatch[1]);
  if (docMatch && method === 'GET') return handleGetDocument(request, env, docMatch[1]);
  if (docMatch && method === 'DELETE') return handleDeleteDocument(request, env, docMatch[1]);

  // The two or three choices a quote offers, and which one the client took.
  if (optionsMatch && method === 'POST') return handleAddOption(request, env, optionsMatch[1]);
  if (chooseMatch && method === 'POST') return handleChooseOption(request, env, chooseMatch[1]);
  if (optionMatch && method === 'PUT') return handleUpdateOption(request, env, optionMatch[1]);
  if (optionMatch && method === 'DELETE') return handleDeleteOption(request, env, optionMatch[1]);

  // What the client loses if they cancel, as the vendor's standard terms or as
  // the terms one trip was actually sold on.
  if (path === '/api/penalties' && method === 'GET') return handleListTiers(request, env);
  if (path === '/api/penalties' && method === 'POST') return handleAddTier(request, env);
  if (applyTermsMatch && method === 'POST') return handleApplyVendorTerms(request, env, applyTermsMatch[1]);
  if (tierMatch && method === 'PUT') return handleUpdateTier(request, env, tierMatch[1]);
  if (tierMatch && method === 'DELETE') return handleDeleteTier(request, env, tierMatch[1]);

  // The people on a reservation, and what the vendor has granted them.
  if (travellersMatch && method === 'POST') return handleAddTraveller(request, env, travellersMatch[1]);
  if (travellerMatch && method === 'PUT') return handleUpdateTraveller(request, env, travellerMatch[1]);
  if (travellerMatch && method === 'DELETE') return handleDeleteTraveller(request, env, travellerMatch[1]);
  if (amenitiesMatch && method === 'POST') return handleAddAmenity(request, env, amenitiesMatch[1]);
  if (amenityMatch && method === 'PUT') return handleUpdateAmenity(request, env, amenityMatch[1]);
  if (amenityMatch && method === 'DELETE') return handleDeleteAmenity(request, env, amenityMatch[1]);

  // What the client pays, in parts, and which parts earn commission.
  if (pricingMatch && method === 'POST') return handleAddPriceLine(request, env, pricingMatch[1]);
  // The whole grid at once: rows of charges against a column per traveller.
  if (pricingMatch && method === 'PUT') return handleSavePricingGrid(request, env, pricingMatch[1]);
  if (priceLineMatch && method === 'PUT') return handleUpdatePriceLine(request, env, priceLineMatch[1]);
  if (priceLineMatch && method === 'DELETE') return handleDeletePriceLine(request, env, priceLineMatch[1]);
  if (bookingMatch && method === 'GET') return handleGetBooking(request, env, bookingMatch[1]);
  if (bookingMatch && method === 'PUT') return handleUpdateBooking(request, env, bookingMatch[1]);
  if (bookingMatch && method === 'DELETE') return handleDeleteBooking(request, env, bookingMatch[1]);

  // ---- conversations ----------------------------------------------------
  if (path === '/api/conversations' && method === 'GET') return handleListConversations(request, env);
  if (path === '/api/conversations/send' && method === 'POST') return handleSendMessage(request, env);
  if (convoMatch && method === 'GET') {
    return handleConversationMessages(request, env, decodeURIComponent(convoMatch[1]));
  }

  // ---- calendar ---------------------------------------------------------
  if (path === '/api/calendar' && method === 'GET') return handleListCalendar(request, env);
  if (path === '/api/calendar/appointments' && method === 'POST') {
    return handleCreateAppointment(request, env);
  }

  // ---- forms and workflows ----------------------------------------------
  if (path === '/api/forms' && method === 'GET') return handleListForms(request, env);
  if (path === '/api/workflows' && method === 'GET') return handleListWorkflows(request, env);
  if (path === '/api/campaigns' && method === 'GET') return handleListCampaigns(request, env);
  if (path === '/api/crm/links' && method === 'GET') return handleCrmLinks(request, env);

  // Our own forms, built and hosted here.
  if (path === '/api/myforms' && method === 'GET') return handleListOwnForms(request, env);
  // Before the /:id match, or "report" is read as a form id.
  if (path === '/api/myforms/report' && method === 'GET') return handleFormsReport(request, env);
  if (leadToBookingMatch && method === 'POST') {
    return handleReservationFromLead(request, env, leadToBookingMatch[1]);
  }
  if (path === '/api/myforms' && method === 'POST') return handleSaveForm(request, env, null);
  if (ownFormMatch && method === 'GET') return handleGetForm(request, env, ownFormMatch[1]);
  if (ownFormMatch && method === 'PUT') return handleSaveForm(request, env, ownFormMatch[1]);
  if (ownFormMatch && method === 'DELETE') return handleDeleteForm(request, env, ownFormMatch[1]);

  // Automations.
  if (path === '/api/automations' && method === 'GET') return handleListAutomations(request, env);
  if (path === '/api/automations' && method === 'POST') return handleSaveAutomation(request, env, null);
  if (path === '/api/automations/run' && method === 'POST') return handleRunAutomations(request, env);
  if (autoMatch && method === 'GET') return handleGetAutomation(request, env, autoMatch[1]);
  if (autoMatch && method === 'PUT') return handleSaveAutomation(request, env, autoMatch[1]);
  if (autoMatch && method === 'DELETE') return handleDeleteAutomation(request, env, autoMatch[1]);

  // Public submission endpoint for a hosted form. Unauthenticated by design.
  if (publicFormMatch && method === 'POST') {
    return handlePublicSubmit(request, env, decodeURIComponent(publicFormMatch[1]));
  }
  if (path === '/api/surveys' && method === 'GET') return handleSurveys(request, env);
  if (path === '/api/marketing' && method === 'GET') return handleMarketing(request, env);
  if (path === '/api/catalog' && method === 'GET') return handleCatalog(request, env);
  if (path === '/api/library' && method === 'GET') return handleLibrary(request, env);
  if (path === '/api/library/media' && method === 'POST') return handleUploadMedia(request, env);
  if (path === '/api/account' && method === 'GET') return handleAccount(request, env);
  if (path === '/api/marketing/social' && method === 'POST') return handleCreateSocialPost(request, env);
  if (path === '/api/catalog/products' && method === 'POST') return handleCreateProduct(request, env);
  if (accountItemMatch && method === 'POST') {
    return handleCreateAccountItem(request, env, accountItemMatch[1]);
  }

  // ---- payments ---------------------------------------------------------
  if (path === '/api/payments' && method === 'GET') return handlePayments(request, env);
  if (path === '/api/payments' && method === 'POST') return handleCreatePayment(request, env);
  if (payPaidMatch && method === 'POST') return handleMarkPaid(request, env, payPaidMatch[1]);
  if (payRemindMatch && method === 'POST') return handlePaymentReminder(request, env, payRemindMatch[1]);
  if (payMatch && method === 'PUT') return handleUpdatePayment(request, env, payMatch[1]);
  if (payMatch && method === 'DELETE') return handleDeletePayment(request, env, payMatch[1]);
  if (scheduleMatch && method === 'POST') {
    return handleGenerateSchedule(request, env, scheduleMatch[1]);
  }
  if (bookingStatusMatch && method === 'POST') {
    return handleSetBookingStatus(request, env, bookingStatusMatch[1]);
  }

  // ---- billing ----------------------------------------------------------
  if (path === '/api/billing' && method === 'GET') return handleBilling(request, env);
  if (path === '/api/billing/invoices' && method === 'POST') return handleCreateInvoice(request, env);
  if (invoiceSendMatch && method === 'POST') {
    return handleSendInvoice(request, env, decodeURIComponent(invoiceSendMatch[1]));
  }

  // ---- dashboard and reports -------------------------------------------
  if (path === '/api/search' && method === 'GET') return handleSearch(request, env);

  // Tasks: the advisor's own working list, not the CRM's.
  // Sharing a trip with the person it is for.
  if (shareMatch && method === 'POST') return handleShareTrip(request, env, shareMatch[1]);
  if (tripMsgMatch && method === 'GET') return handleTripMessages(request, env, tripMsgMatch[1]);
  if (msgReadMatch && method === 'POST') return handleReadTripMessage(request, env, msgReadMatch[1]);
  if (docShareMatch && method === 'POST') return handleShareDocument(request, env, docShareMatch[1]);

  if (path === '/api/tasks' && method === 'GET') return handleListMyTasks(request, env);
  if (path === '/api/tasks' && method === 'POST') return handleCreateMyTask(request, env);
  if (myTaskMatch && method === 'PUT') return handleUpdateMyTask(request, env, myTaskMatch[1]);
  if (myTaskMatch && method === 'DELETE') return handleDeleteMyTask(request, env, myTaskMatch[1]);
  if (taskItemsMatch && method === 'GET') return handleListTaskItems(request, env, taskItemsMatch[1]);
  if (taskItemsMatch && method === 'POST') return handleCreateTaskItem(request, env, taskItemsMatch[1]);
  if (taskItemMatch && method === 'PUT') return handleUpdateTaskItem(request, env, taskItemMatch[1]);
  if (taskItemMatch && method === 'DELETE') return handleDeleteTaskItem(request, env, taskItemMatch[1]);

  // The standard tasks that follow a kind of trip, written once.
  if (path === '/api/task-templates' && method === 'GET') return handleListTemplates(request, env);
  if (path === '/api/task-templates' && method === 'POST') return handleSaveTemplate(request, env);
  if (path === '/api/task-templates/seed' && method === 'POST') return handleSeedTemplates(request, env);
  if (templateMatch && templateMatch[1] !== 'seed' && method === 'PUT') {
    return handleSaveTemplate(request, env, templateMatch[1]);
  }
  if (templateMatch && method === 'DELETE') return handleDeleteTemplate(request, env, templateMatch[1]);

  // Group space: cabins held by a vendor before anybody has booked them.
  if (path === '/api/groups' && method === 'GET') return handleListGroups(request, env);
  if (path === '/api/groups' && method === 'POST') return handleCreateGroup(request, env);
  if (groupBookMatch && method === 'POST') return handleBookRegistration(request, env, groupBookMatch[1]);
  if (groupMatch && method === 'GET') return handleGetGroup(request, env, groupMatch[1]);
  if (groupMatch && method === 'PUT') return handleUpdateGroup(request, env, groupMatch[1]);
  if (groupMatch && method === 'DELETE') return handleDeleteGroup(request, env, groupMatch[1]);

  // Credits a client already holds with a vendor, and when they lapse.
  if (path === '/api/credits' && method === 'GET') return handleListCredits(request, env);
  if (path === '/api/credits' && method === 'POST') return handleCreateCredit(request, env);
  if (creditMatch && method === 'PUT') return handleUpdateCredit(request, env, creditMatch[1]);
  if (creditMatch && method === 'DELETE') return handleDeleteCredit(request, env, creditMatch[1]);

  // Who to call this week, drawn from what the other screens already hold.
  if (path === '/api/hotlists' && method === 'GET') return handleHotLists(request, env);
  if (path === '/api/hotlists/done' && method === 'POST') return handleHotListDone(request, env);
  if (path === '/api/hotlists/undo' && method === 'POST') return handleHotListUndo(request, env);

  // Deals worth telling people about, and when each one dies.
  if (path === '/api/specials' && method === 'GET') return handleListSpecials(request, env);
  if (path === '/api/specials' && method === 'POST') return handleCreateSpecial(request, env);
  if (specialMatch && method === 'GET') return handleGetSpecial(request, env, specialMatch[1]);
  if (specialMatch && method === 'PUT') return handleUpdateSpecial(request, env, specialMatch[1]);
  if (specialMatch && method === 'DELETE') return handleDeleteSpecial(request, env, specialMatch[1]);
  if (enquiryBookMatch && method === 'POST') return handleBookEnquiry(request, env, enquiryBookMatch[1]);
  if (enquiryMatch && method === 'DELETE') return handleDeleteEnquiry(request, env, enquiryMatch[1]);
  if (path === '/api/prefs/dashboard' && method === 'GET') return handleGetLayout(request, env);
  if (path === '/api/prefs/dashboard' && method === 'PUT') return handleSaveLayout(request, env);
  if (path === '/api/prefs/dashboard' && method === 'DELETE') return handleResetLayout(request, env);
  // Reading a vendor confirmation instead of retyping it.
  if (path === '/api/import/confirmation' && method === 'POST') return handleReadConfirmation(request, env);
  if (path === '/api/dashboard' && method === 'GET') return handleDashboard(request, env);
  if (path === '/api/month' && method === 'GET') return handleMonth(request, env);
  if (path === '/api/goals' && method === 'GET') return handleGetGoals(request, env);
  if (path === '/api/goals' && method === 'PUT') return handleSaveGoals(request, env);
  if (path === '/api/client' && method === 'GET') return handleClientRecord(request, env);
  if (path === '/api/clients' && method === 'GET') return handleListClients(request, env);
  if (path === '/api/import/preview' && method === 'POST') return handlePreviewImport(request, env);
  if (path === '/api/import/reservations' && method === 'POST') return handleRunImport(request, env);

  // The sailing catalog: a real vendor, ship and pair of dates, rather than
  // whatever was typed.
  // Vendors: spelling, and the terms they trade on.
  if (path === '/api/vendors' && method === 'GET') return handleListVendors(request, env);
  if (path === '/api/vendors' && method === 'POST') return handleCreateVendor(request, env);
  if (path === '/api/vendors/import' && method === 'POST') return handleImportVendors(request, env);
  if (path === '/api/vendors/merge' && method === 'POST') return handleMergeVendors(request, env);
  if (path === '/api/vendors/suggest-dates' && method === 'GET') return handleSuggestDates(request, env);
  // Before the bare vendor match, so the longer path is not swallowed by it.
  if (vendorStarMatch && method === 'POST') return handleFavouriteVendor(request, env, vendorStarMatch[1]);
  if (vendorMatch && method === 'GET') return handleGetVendor(request, env, vendorMatch[1]);
  if (vendorMatch && method === 'PUT') return handleUpdateVendor(request, env, vendorMatch[1]);
  if (vendorMatch && method === 'DELETE') return handleDeleteVendor(request, env, vendorMatch[1]);

  if (path === '/api/catalog/search' && method === 'GET') return handleCatalogSearch(request, env);
  if (path === '/api/catalog/sailing' && method === 'GET') return handleCatalogSailing(request, env);
  if (path === '/api/catalog/lines' && method === 'GET') return handleCatalogLines(request, env);
  if (path === '/api/catalog/ships' && method === 'GET') return handleCatalogShips(request, env);
  if (path === '/api/catalog/dates' && method === 'GET') return handleCatalogDates(request, env);
  if (path === '/api/catalog/suggest' && method === 'GET') return handleCatalogSuggest(request, env);
  if (path === '/api/catalog/apply' && method === 'POST') return handleCatalogApply(request, env);
  if (path === '/api/admin/catalog' && method === 'GET') return handleCatalogStatus(request, env);
  if (path === '/api/admin/catalog' && method === 'POST') return handleCatalogImport(request, env);
  if (clientMatch && method === 'PUT') return handleUpdateClient(request, env, clientMatch[1]);
  if (path === '/api/commissions' && method === 'GET') return handleListCommissions(request, env);
  // Ordered before the bare statement match so the longer path wins: a regex
  // for /statements/:id also matches /statements/:id/candidates otherwise.
  if (candidatesMatch && method === 'GET') return handleStatementCandidates(request, env, candidatesMatch[1]);
  if (path === '/api/commissions/receipts' && method === 'GET') return handleListReceipts(request, env);
  if (path === '/api/commissions/receipts' && method === 'POST') return handleAddReceipt(request, env);
  if (receiptMatch && method === 'DELETE') return handleDeleteReceipt(request, env, receiptMatch[1]);
  if (path === '/api/commissions/statements' && method === 'GET') return handleListStatements(request, env);
  if (path === '/api/commissions/statements' && method === 'POST') return handleCreateStatement(request, env);
  if (vendorStatementMatch && method === 'PUT') return handleUpdateStatement(request, env, vendorStatementMatch[1]);
  if (vendorStatementMatch && method === 'DELETE') return handleDeleteStatement(request, env, vendorStatementMatch[1]);
  if (path === '/api/commissions/status' && method === 'POST') {
    return handleSetCommissionStatus(request, env);
  }
  if (path === '/api/reports/production' && method === 'GET') return handleProduction(request, env);
  // Everyone whose documents will stop them travelling, across the whole book.
  if (path === '/api/documents' && method === 'GET') return handleDocumentWatch(request, env);

  // ---- admin ------------------------------------------------------------
  if (path === '/api/admin/health' && method === 'GET') return handleHealth(request, env);
  if (path === '/api/admin/catalog-mirror' && method === 'GET') return handleMirrorStatus(request, env);
  if (path === '/api/admin/catalog-mirror' && method === 'POST') return handleMirrorCatalog(request, env);
  if (path === '/api/admin/test-email' && method === 'POST') return handleTestEmail(request, env);
  if (path === '/api/admin/task-reminders' && method === 'POST') return handleRunTaskReminders(request, env);
  if (path === '/api/admin/payment-reminders' && method === 'POST') return handleRunPaymentReminders(request, env);
  if (path === '/api/admin/call-lists' && method === 'POST') return handleRunCallLists(request, env);
  if (path === '/api/admin/sync' && method === 'GET') return handleSyncStatus(request, env);
  if (path === '/api/admin/sync' && method === 'POST') return handleRunSync(request, env);
  if (path === '/api/admin/lifecycle' && method === 'POST') return handleRunLifecycle(request, env);
  if (path === '/api/admin/advisors' && method === 'GET') return handleListAdvisors(request, env);
  if (advisorMatch && method === 'PUT') {
    const id = decodeURIComponent(advisorMatch[1]);
    if (advisorMatch[2] === 'status') return handleSetAdvisorStatus(request, env, id);
    if (advisorMatch[2] === 'split') return handleSetAdvisorSplit(request, env, id);
    return handleSetAdvisorGhl(request, env, id);
  }

  return notFound('No such endpoint.');
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
async function routePage(request, env, path) {
  // Hosted forms are public: no session, no gate. They are how leads arrive.
  const hosted = path.match(/^\/f\/([^/]+)\/?$/);
  if (hosted) return renderPublicForm(request, env, decodeURIComponent(hosted[1]));

  // A client's own trip, on a code that is not the booking id. Read only: it
  // answers "what is booked, what have I paid, what is due", which otherwise
  // lives in an inbox. The POST is the note back, which is the only thing a
  // client can do here.
  const tripDoc = path.match(/^\/t\/([^/]+)\/d\/([^/]+)$/);
  if (tripDoc) {
    return serveTripDocument(request, env,
      decodeURIComponent(tripDoc[1]), decodeURIComponent(tripDoc[2]));
  }
  const tripPage = path.match(/^\/t\/([^/]+)\/?$/);
  if (tripPage) {
    const tripCode = decodeURIComponent(tripPage[1]);
    return request.method === 'POST'
      ? handleTripMessage(request, env, tripCode)
      : renderTripPage(request, env, tripCode);
  }

  // A group's own page, on the same terms: public, because it is how names
  // arrive for a trip nobody has been told about yet.
  const groupPage = path.match(/^\/g\/([^/]+)\/?$/);
  if (groupPage) {
    const code = decodeURIComponent(groupPage[1]);
    return request.method === 'POST'
      ? handleGroupRegistration(request, env, code)
      : renderGroupPage(request, env, code);
  }

  // A deal's own page, public because it is what gets posted and emailed.
  const specialPage = path.match(/^\/s\/([^/]+)\/?$/);
  if (specialPage) {
    const code = decodeURIComponent(specialPage[1]);
    return request.method === 'POST'
      ? handleSpecialEnquiry(request, env, code)
      : renderSpecialPage(request, env, code);
  }

  const needsAuth = path.startsWith('/app');
  const needsAdmin = path.startsWith('/admin');

  if (needsAuth || needsAdmin) {
    const user = await getCurrentUser(request, env);

    if (!user) {
      const next = encodeURIComponent(path);
      return redirect(`/login?next=${next}`);
    }
    if (user.status === 'pending') return redirect('/pending');
    if (user.status !== 'active') return redirect('/login?error=suspended');
    if (needsAdmin && !isAdmin(user)) return redirect('/app/');
  }

  // Signed-in advisors should not sit on the sign-in pages.
  if (path === '/login' || path === '/login.html' || path === '/' || path === '/index.html') {
    const user = await getCurrentUser(request, env);
    if (user && user.status === 'active') {
      return redirect(isAdmin(user) ? '/admin/' : '/app/');
    }
  }

  return serveAsset(request, env, path);
}

async function serveAsset(request, env, path) {
  const file = PAGE_FILES[path] || path;
  const assetUrl = new URL(request.url);
  assetUrl.pathname = file;

  const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  if (res.status !== 404) return res;

  // Extension-less path that is not in the map: try <path>.html once.
  if (!/\.[a-z0-9]+$/i.test(path)) {
    assetUrl.pathname = `${path.replace(/\/$/, '')}.html`;
    const retry = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    if (retry.status !== 404) return retry;
  }

  assetUrl.pathname = '/404.html';
  const fallback = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  return new Response(fallback.body, {
    status: 404,
    headers: fallback.headers,
  });
}

export { PUBLIC_PAGES };
