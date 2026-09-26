// CTT Agent Portal Worker.
//
// Routes the JSON API, gates the portal pages behind a session (and /admin
// behind the admin role), and serves the static files in ./public.
//
// [assets] run_worker_first = true in wrangler.toml is what makes the gate
// real: every request lands here first, and protected HTML is only served
// after the session check passes.

import {
  redirect,
  notFound,
  json,
} from './util.js'; import {
  handleLogin,
  handleLogout,
  handleMe,
  handleForgot,
  handleReset,
  handleChangePassword,
  handleUpdateProfile,
  getCurrentUser,
  isAdmin,
} from './auth.js'; import {
  handleListOpportunities,
} from './pipeline.js';
import {
  handleLeadBoard, handleAddLead, handleUpdateLead, handleMoveLead, handleCloseLead,
  handleFollowedUp,
} from './leads.js';
import { handleProposals, handleMarkBooked, handleSetDeclined } from './proposals.js'; import {
  handleListBookings,
  handleGetBooking,
  handleBookingRecord,
  handleCreateBooking,
  handleUpdateBooking,
  handleQuickUpdate,
  handleDeleteBooking,
  handleWelcomed,
} from './bookings.js'; import {
  markReturnedTripsTravelled,
} from './db.js'; import {
  mirrorCatalogStep,
} from './catalogmirror.js'; import {
  remindTasks,
} from './taskmail.js'; import {
  remindDuePayments,
} from './payremind.js'; import {
  sendCallLists,
} from './calllist.js'; import {
  handleShareTrip,
  handleShareDocument,
  handleTripMessages,
  handleReadTripMessage,
  renderTripPage,
  handleTripMessage,
  handleTripUpload,
  handleTripReview,
  handleClientChoose,
  handleClientDecline,
  serveTripDocument,
  renderTripManifest,
} from './share.js';
import { handleShareClient, renderHubPage } from './hub.js';
import { handleDuplicates, handleMergeClients } from './merge.js';
import { renderPortal, handlePortalSignIn } from './portal.js';
import { handleClientLinkRedeem, handleClientSignOut } from './clientauth.js';
import {
  handleReadConfirmation,
} from './confirm.js';
import {
  migrationHint,
} from './schema-drift.js';
import {
  runJob,
  jobHealth,
} from './cronlog.js';
import {
  renderUnsubscribe,
  handleUnsubscribe,
  handleListSuppressions,
  handleAddSuppression,
  handleRestoreSuppression,
} from './suppression.js';
import {
  handleSegmentRules,
  handleSegmentPreview,
  handleListSegments,
  handleSaveSegment,
  handleDeleteSegment,
} from './segments.js';
import {
  handleListBroadcasts,
  handleGetBroadcast,
  handleSaveBroadcast,
  handleDeleteBroadcast,
  handlePreviewBroadcast,
  handleTestBroadcast,
  handleSendBroadcast,
  handleCancelBroadcast,
  sendQueuedBroadcasts,
} from './broadcasts.js';
import { handleDeleteComponent } from './components.js';
import {
  handleUploadDocument,
  handleGetDocument,
  handleDeleteDocument,
} from './documents.js';
import {
  handleStatement,
} from './statement.js';
import {
  handleAddOption,
  handleUpdateOption,
  handleDeleteOption,
  handleChooseOption,
  handleRecommendOption,
  handleOpenOptions,
} from './options.js';
import {
  handleListTiers,
  handleAddTier,
  handleUpdateTier,
  handleDeleteTier,
  handleApplyVendorTerms,
} from './penalties.js';
import {
  handlePayments,
  handleCreatePayment,
  handlePaymentReminder,
  handleUpdatePayment,
  handleMarkPaid,
  handleDeletePayment,
  handleGenerateSchedule,
  handleSetBookingStatus,
} from './payments.js';
import {
  handleListForms as handleListOwnForms,
  handleGetForm,
  handleSaveForm,
  handleDeleteForm,
  handleSendForm,
  handleFormInvites,
  handleListMyTemplates,
  handleSaveMyTemplate,
  handleDeleteMyTemplate,
  handleFormsReport,
  handleReservationFromLead,
} from './formbuilder.js';
import {
  handleListAppointments,
  handleCreateAppointment,
  handleUpdateAppointment,
  handleDeleteAppointment,
  handleImportInvite,
  handleInviteAddress,
} from './appointments.js';
import {
  handleChat,
  handleChannelMessages,
  handlePostMessage,
  handleEditMessage,
  handleDeleteMessage,
  handleMarkRead,
  handleCreateChannel,
  handleOpenDm,
  handleRecordThread,
  handleChatUnread,
  handleCloseRoom,
} from './chat.js';
import { handleCalendar } from './calendar.js';
import { handleAlerts, handleAlertsSeen, pushWaiting } from './alerts.js';
import { handleInboundInvite } from './inbound.js';
import {
  handlePushKey, handlePushSubscribe, handlePushUnsubscribe, handlePushTest,
} from './push.js';
import {
  renderPublicForm,
  handlePublicSubmit,
  renderGroupPage,
  handleGroupRegistration,
  renderSpecialPage,
  handleSpecialEnquiry,
} from './publicform.js';
import {
  handleSearch,
} from './search.js';
import {
  handleGetLayout,
  handleSaveLayout,
  handleResetLayout,
} from './prefs.js';
// Aliased so the names read as what they are: an advisor's own working list,
// which is the only kind of task there is now.
import {
  handleListTasks as handleListMyTasks,
  handleCreateTask as handleCreateMyTask,
  handleUpdateTask as handleUpdateMyTask,
  handleDeleteTask as handleDeleteMyTask,
  handleListTaskItems,
  handleCreateTaskItem,
  handleUpdateTaskItem,
  handleDeleteTaskItem,
} from './tasks.js';
import {
  handleListTemplates,
  handleSaveTemplate,
  handleDeleteTemplate,
  handleSeedTemplates,
} from './tasktemplates.js';
import {
  handleListGroups,
  handleGetGroup,
  handleBookRegistration,
  handleCreateGroup,
  handleUpdateGroup,
  handleDeleteGroup,
} from './groups.js';
import {
  handleListCredits,
  handleCreateCredit,
  handleUpdateCredit,
  handleDeleteCredit,
} from './credits.js';
import {
  handleHotLists,
  handleHotListDone,
  handleHotListUndo,
} from './hotlists.js';
import {
  handleListSpecials,
  handleGetSpecial,
  handleCreateSpecial,
  handleUpdateSpecial,
  handleDeleteSpecial,
  handleBookEnquiry,
  handleDeleteEnquiry,
} from './specials.js';
import {
  handleListAgencies,
  handleCreateAgency,
  handleUpdateAgency,
  handleSetAdvisorAgency,
} from './agencies.js';
import {
  handleListHouseholds,
  handleCreateHousehold,
  handleUpdateHousehold,
  handleAddMember,
  handleRemoveMember,
  handleDeleteHousehold,
  handleHouseholdTravellers,
  handleHouseholdRecord,
  handleSuggestHouseholds,
} from './households.js';
import {
  handleListItinerary,
  handleSaveItem,
  handleDeleteItem,
  handleShareItinerary,
  handleReorderItinerary,
} from './itinerary.js';
import {
  handleListLibrary,
  handleSaveLibraryPiece,
  handleDeleteLibraryPiece,
  handleUseLibraryPiece,
} from './itinlibrary.js';
import {
  handleGetGoals,
  handleSaveGoals,
} from './goals.js';
import {
  handleListCommissions,
  handleSetCommissionStatus,
} from './commissions.js';
import {
  handleListReceipts,
  handleAddReceipt,
  handleDeleteReceipt,
  handleListStatements,
  handleCreateStatement,
  handleUpdateStatement,
  handleDeleteStatement,
  handleStatementCandidates,
} from './reconcile.js';
import {
  handleListPayouts,
  handleCreatePayout,
  handleDeletePayout,
} from './payouts.js';
import {
  handleClientRecord,
  handleListClients,
  handleUpdateClient,
  handleCreateClient,
} from './clients.js';
import {
  handlePreviewImport,
  handleRunImport,
  handlePreviewClientImport,
  handleRunClientImport,
} from './importer.js';
import {
  handleCatalogLines,
  handleCatalogSearch,
  handleCatalogSailing,
  handleCatalogShips,
  handleCatalogDates,
  handleCatalogStatus,
  handleCatalogImport,
  handleCatalogSuggest,
  handleCatalogApply,
} from './catalogapi.js';
import {
  importCatalogStep,
} from './catalog.js';
import {
  handleListVendors,
  handleUpdateVendor,
  handleMergeVendors,
  handleSuggestDates,
  handleFavouriteVendor,
  handleCreateVendor,
  handleDeleteVendor,
  handleImportVendors,
  handleGetVendor,
} from './vendors.js';
import {
  handleAddTraveller,
  handleUpdateTraveller,
  handleDeleteTraveller,
  handleAddAmenity,
  handleUpdateAmenity,
  handleDeleteAmenity,
  handleDocumentWatch,
} from './travellers.js';
import {
  handleAddPriceLine,
  handleUpdatePriceLine,
  handleDeletePriceLine,
  handleSavePricingGrid,
} from './pricing.js';
import {
  handleListAutomations,
  handleGetAutomation,
  handleSaveAutomation,
  handleDeleteAutomation,
  handleRunAutomations,
  processDueRuns,
  scanTimeTriggers,
  purgeOldRuns,
} from './automations.js';
import {
  handleDashboard,
  handleProduction,
  handleMonth,
} from './reports.js';
import { handleAttribution } from './attribution.js';
import { handleListReviews, handleAskReview } from './reviews.js';
import {
  handleListAdvisors,
  handleSetAdvisorStatus,
  handleSetAdvisorSplit,
  handleUpdateAdvisor,
  handleCreateAdvisor,
  handleReissueInvite,
  handleStartActing,
  handleStopActing,
  handleSetBookingSplit,
  handleSetBookingAdvisor,
  handleRunLifecycle,
  handleHealth,
  handleTestEmail,
  handleRunTaskReminders,
  handleRunPaymentReminders,
  handleRunCallLists,
  handleMirrorCatalog,
  handleMirrorStatus,
} from './admin.js';
import {
  purgeExpiredSessions,
} from './db.js';
import {
  handleMembership,
  handleCheckout,
  handlePortal,
  handleStripeWebhook,
} from './membership.js';

// Pages any visitor may reach.
const PUBLIC_PAGES = new Set([
  '/', '/index.html',
  '/login', '/login.html',
  '/forgot-password', '/forgot-password.html',
  '/reset-password', '/reset-password.html',
  '/pending', '/pending.html',
]);

// Extension-less page paths mapped to the file that serves them.
const PAGE_FILES = {
  '/': '/index.html',
  '/login': '/login.html',
  '/forgot-password': '/forgot-password.html',
  '/reset-password': '/reset-password.html',
  '/pending': '/pending.html',
  '/app': '/app/index.html',
  '/app/': '/app/index.html',
  '/app/payments': '/app/payments.html',
  '/app/calendar': '/app/calendar.html',
  '/app/chat': '/app/chat.html',
  '/app/formbuilder': '/app/formbuilder.html',
  '/app/qr': '/app/qr.html',
  '/app/automations': '/app/automations.html',
  '/app/pipeline': '/app/pipeline.html',
  '/app/proposals': '/app/proposals.html',
  '/app/leads': '/app/leads.html',
  '/app/tasks': '/app/tasks.html',
  '/app/new': '/app/new.html',
  '/app/groups': '/app/groups.html',
  '/app/credits': '/app/credits.html',
  '/app/hotlists': '/app/hotlists.html',
  '/app/households': '/app/households.html',
  '/app/membership': '/app/membership.html',
  '/admin/agencies': '/admin/agencies.html',
  '/app/specials': '/app/specials.html',
  '/app/special': '/app/special.html',
  '/app/goals': '/app/goals.html',
  '/app/commissions': '/app/commissions.html',
  '/app/reservations': '/app/reservations.html',
  '/app/reservation': '/app/reservation.html',
  '/app/client': '/app/client.html',
  '/app/clients': '/app/clients.html',
  '/app/reviews': '/app/reviews.html',
  '/app/import': '/app/import.html',
  '/app/import-clients': '/app/import-clients.html',
  '/app/segments': '/app/segments.html',
  '/app/manual': '/app/manual.html',
  '/app/broadcasts': '/app/broadcasts.html',
  '/app/broadcast': '/app/broadcast.html',
  '/app/complete': '/app/complete.html',
  '/app/vendors': '/app/vendors.html',
  '/app/vendor': '/app/vendor.html',
  '/app/group': '/app/group.html',
  '/app/cruise-search': '/app/cruise-search.html',
  '/app/form': '/app/form.html',
  '/app/bookings': '/app/reservations.html',
  '/app/reports': '/app/reports.html',
  '/app/settings': '/app/settings.html',
  '/admin/manual': '/admin/manual.html',
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
  /**
   * A forwarded meeting invite, arriving as mail.
   *
   * Cloudflare hands this the message; everything it means is worked out in
   * inbound.js, which takes a string and can therefore be run without a mail
   * server. This is the part that turns one into the other.
   *
   * A refusal bounces with the reason. An advisor who forwards something and
   * hears nothing cannot tell "it worked" from "it went in the bin", and
   * silence is how an inbound integration loses everybody's trust.
   */
  async email(message, env, ctx) {
    try {
      // A meeting invite is a few kilobytes. Anything of this size is a
      // newsletter, a photo, or somebody's mailbox pointed at us by mistake.
      if (message.rawSize > 1024 * 1024) {
        message.setReject('That message is too large to be a meeting invite.');
        return;
      }
      const raw = await new Response(message.raw).text();
      const res = await handleInboundInvite(env, { to: message.to, raw });
      if (res.reject) {
        message.setReject(res.reject);
        return;
      }
      // Nothing to send back on success. The appointment turning up on the
      // calendar, and in the bell, is the confirmation; a reply to every
      // forward is a second inbox to ignore.
      ctx.waitUntil(Promise.resolve());
    } catch (e) {
      console.error('inbound invite', e);
      message.setReject('That invite could not be read. Try adding it from the '
        + 'Calendar page instead.');
    }
  },

  async scheduled(event, env, ctx) {
    // Every job goes through runJob, which records when it last ran and when
    // it last ran without throwing. The catch each of these used to carry was
    // right and incomplete: one broken job must not stop the other eleven, and
    // nobody reads a Worker's console, so a job failing since March looked
    // exactly like a job with nothing to do.
    const job = (name, fn) => ctx.waitUntil(runJob(env, name, fn));

    job('purge sessions', () => purgeExpiredSessions(env));
    job('purge automation runs', () => purgeOldRuns(env));

    // The catalog import is a no-op once the current monthly snapshot is fully
    // imported, so running it on every tick costs one request a day and the
    // catalog is never more than five minutes behind a new snapshot.
    job('catalog import', () => importCatalogStep(env, { maxPages: 8 }));

    // Without a feed key of its own, the catalog is mirrored from the copy
    // CruiseShoppers already holds. A finished pass costs one request, so this
    // is cheap on the ticks where there is nothing to do.
    job('catalog mirror', () => mirrorCatalogStep(env, { maxShips: 8 }));

    // A trip whose return date has passed has been travelled. Nothing else
    // ever set that status, so the reports said nobody had been anywhere.
    job('mark trips travelled', () => markReturnedTripsTravelled(env,
      { today: new Date().toISOString().slice(0, 10) }));

    // What is due today and what is late, once a day. A no-op before the hour
    // and for any task already told about, so running it every five minutes
    // costs one query on almost every tick.
    job('task reminders', () => remindTasks(env));

    // And the same thing for anybody who asked to be told on their phone.
    // Timeliness is the only reason this exists, so it runs on the ordinary
    // tick rather than once in the morning; at most one knock an hour per
    // device, because the thing worth protecting is somebody leaving it on.
    job('push waiting', () => pushWaiting(env));

    // And the client side of the same idea: the money is due on a date, and
    // the advisor pressing send is the part that does not scale. Only for
    // advisors who turned it on, and only on real vendor deadlines.
    job('payment reminders', () => remindDuePayments(env));

    // And once a week, the calls nothing else is chasing anybody about. A
    // no-op on six days in seven, so this costs one query on almost every tick.
    job('call lists', () => sendCallLists(env));

    // A broadcast is queued as rows and drained here, a batch at a time. A
    // no-op when nothing is sending, which is almost every tick.
    job('broadcasts', () => sendQueuedBroadcasts(env));

    // Look for time based triggers, then advance whatever is due. Order
    // matters inside this one: scanning first means a payment that just came
    // into range is acted on in the same pass rather than waiting five more
    // minutes. One job rather than two, because the second half is pointless
    // without the first.
    job('automations', async () => {
      // Every agency with something listening, rather than one.
      //
      // This passed the tenant of no user at all, which resolved to a single
      // shared default, so the sweep only ever covered advisors who had no
      // partition of their own. Anybody with one got no time based automation
      // at all, and nothing said so: an automation that never fires and an
      // automation nobody triggered look the same from outside.
      //
      // Read from the automations themselves rather than from the agency list,
      // because an agency with nothing active has nothing to scan for.
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT agency_id FROM automations
          WHERE active = 1 AND agency_id IS NOT NULL AND agency_id <> ''`
      ).all();
      for (const row of results || []) await scanTimeTriggers(env, row.agency_id);
      await processDueRuns(env);
    });
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
  const leadMatch = path.match(/^\/api\/leads\/([^/]+)$/);
  const leadStageMatch = path.match(/^\/api\/leads\/([^/]+)\/stage$/);
  const leadDoneMatch = path.match(/^\/api\/leads\/([^/]+)\/followed$/);
  const bookingMatch = path.match(/^\/api\/bookings\/([^/]+)$/);
  const recordMatch = path.match(/^\/api\/bookings\/([^/]+)\/record$/);
  const quickMatch = path.match(/^\/api\/bookings\/([^/]+)\/quick$/);
  const statementMatch = path.match(/^\/api\/bookings\/([^/]+)\/statement$/);
  const welcomedMatch = path.match(/^\/api\/bookings\/([^/]+)\/welcomed$/);
  const shareMatch = path.match(/^\/api\/bookings\/([^/]+)\/share$/);
  const clientHubMatch = path.match(/^\/api\/clients\/([^/]+)\/hub$/);
  const segMatch = path.match(/^\/api\/segments\/([^/]+)$/);
  const castMatch = path.match(/^\/api\/broadcasts\/([^/]+)$/);
  const castActMatch = path.match(/^\/api\/broadcasts\/([^/]+)\/(test|send|cancel)$/);
  const tripMsgMatch = path.match(/^\/api\/bookings\/([^/]+)\/messages$/);
  const msgReadMatch = path.match(/^\/api\/trip-messages\/([^/]+)\/read$/);
  const docShareMatch = path.match(/^\/api\/documents\/([^/]+)\/share$/);
  const docsMatch = path.match(/^\/api\/bookings\/([^/]+)\/documents$/);
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
  const recommendMatch = path.match(/^\/api\/options\/([^/]+)\/recommend$/);
  const tierMatch = path.match(/^\/api\/penalties\/([^/]+)$/);
  const applyTermsMatch = path.match(/^\/api\/bookings\/([^/]+)\/penalties\/apply$/);
  const priceLineMatch = path.match(/^\/api\/pricing\/([^/]+)$/);
  const apptMatch = path.match(/^\/api\/appointments\/([^/]+)$/);
  const ownFormMatch = path.match(/^\/api\/myforms\/([^/]+)$/);
  const formSendMatch = path.match(/^\/api\/myforms\/([^/]+)\/send$/);
  const formInvitesMatch = path.match(/^\/api\/myforms\/([^/]+)\/invites$/);
  const leadToBookingMatch = path.match(/^\/api\/leads\/submissions\/([^/]+)\/reservation$/);
  const publicFormMatch = path.match(/^\/api\/public\/forms\/([^/]+)$/);
  // Excludes /run, which is an action rather than an automation id.
  const autoMatch = path.match(/^\/api\/automations\/(?!run$)([^/]+)$/);
  const payMatch = path.match(/^\/api\/payments\/([^/]+)$/);
  const payPaidMatch = path.match(/^\/api\/payments\/([^/]+)\/paid$/);
  const payRemindMatch = path.match(/^\/api\/payments\/([^/]+)\/remind$/);
  const scheduleMatch = path.match(/^\/api\/bookings\/([^/]+)\/schedule$/);
  const bookingStatusMatch = path.match(/^\/api\/bookings\/([^/]+)\/status$/);
  const advisorMatch = path.match(/^\/api\/admin\/advisors\/([^/]+)\/(status|split|invite)$/);
  const advisorOneMatch = path.match(/^\/api\/admin\/advisors\/([^/]+)$/);
  const actMatch = path.match(/^\/api\/admin\/act\/([^/]+)$/);
  const bookingSplitMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/split$/);
  const bookingAdvisorMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/advisor$/);
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
  const myTplMatch = path.match(/^\/api\/form-templates\/([^/]+)$/);
  const itinMatch = path.match(/^\/api\/bookings\/([^/]+)\/itinerary$/);
  const itinItemMatch = path.match(/^\/api\/bookings\/([^/]+)\/itinerary\/([^/]+)$/);
  const itinShareMatch = path.match(/^\/api\/bookings\/([^/]+)\/itinerary-shared$/);
  const itinUseMatch = path.match(/^\/api\/bookings\/([^/]+)\/itinerary\/from-library$/);
  const itinOrderMatch = path.match(/^\/api\/bookings\/([^/]+)\/itinerary\/reorder$/);
  const optionsOpenMatch = path.match(/^\/api\/bookings\/([^/]+)\/options-open$/);
  const libMatch = path.match(/^\/api\/itinerary-library\/([^/]+)$/);
  const houseMatch = path.match(/^\/api\/households\/([^/]+)$/);
  const houseMemberMatch = path.match(/^\/api\/households\/([^/]+)\/members$/);
  const houseDropMatch = path.match(/^\/api\/households\/([^/]+)\/members\/([^/]+)$/);
  const agencyMatch = path.match(/^\/api\/agencies\/([^/]+)$/);
  const advisorAgencyMatch = path.match(/^\/api\/admin\/advisors\/([^/]+)\/agency$/);
  const enquiryBookMatch = path.match(/^\/api\/specials\/enquiries\/([^/]+)\/book$/);
  const enquiryMatch = path.match(/^\/api\/specials\/enquiries\/([^/]+)$/);
  const receiptMatch = path.match(/^\/api\/commissions\/receipts\/([^/]+)$/);
  const payoutMatch = path.match(/^\/api\/payouts\/([^/]+)$/);
  const vendorStatementMatch = path.match(/^\/api\/commissions\/statements\/([^/]+)$/);
  const candidatesMatch = path.match(/^\/api\/commissions\/statements\/([^/]+)\/candidates$/);
  const clientMatch = path.match(/^\/api\/clients\/([^/]+)$/);
  const vendorMatch = path.match(/^\/api\/vendors\/([^/]+)$/);
  const vendorStarMatch = path.match(/^\/api\/vendors\/([^/]+)\/favourite$/);

  // ---- auth -------------------------------------------------------------
  // ---- membership -------------------------------------------------------
  // Stripe's callback, before anything that needs a session: it arrives from
  // Stripe with no cookie, and is trusted only because the signature over the
  // raw body checks out.
  if (path === '/api/stripe/webhook' && method === 'POST') return handleStripeWebhook(request, env);
  if (path === '/api/billing/membership' && method === 'GET') return handleMembership(request, env);
  if (path === '/api/billing/checkout' && method === 'POST') return handleCheckout(request, env);
  if (path === '/api/billing/portal' && method === 'POST') return handlePortal(request, env);

  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
  if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
  if (path === '/api/auth/forgot' && method === 'POST') return handleForgot(request, env);
  if (path === '/api/auth/reset' && method === 'POST') return handleReset(request, env);
  if (path === '/api/auth/password' && method === 'POST') return handleChangePassword(request, env);
  if (path === '/api/auth/profile' && method === 'PUT') return handleUpdateProfile(request, env);

  // ---- leads ------------------------------------------------------------

  // ---- pipeline ---------------------------------------------------------
  // Everything quoted and still unanswered, by who is holding it up.
  if (path === '/api/proposals' && method === 'GET') return handleProposals(request, env);
  const bookedMatch = path.match(/^\/api\/bookings\/([^/]+)\/booked$/);
  if (bookedMatch && method === 'POST') return handleMarkBooked(request, env, bookedMatch[1]);
  const declinedMatch = path.match(/^\/api\/bookings\/([^/]+)\/declined$/);
  if (declinedMatch && method === 'POST') return handleSetDeclined(request, env, declinedMatch[1]);

  // The marketing pipeline: people who have not booked yet.
  if (path === '/api/leads' && method === 'GET') return handleLeadBoard(request, env);
  if (path === '/api/leads' && method === 'POST') return handleAddLead(request, env);
  if (leadMatch && method === 'PUT') return handleUpdateLead(request, env, leadMatch[1]);
  if (leadMatch && method === 'DELETE') return handleCloseLead(request, env, leadMatch[1]);
  if (leadStageMatch && method === 'POST') return handleMoveLead(request, env, leadStageMatch[1]);
  // A follow-up done from the To do drawer: the date goes, the lead stays.
  if (leadDoneMatch && method === 'POST') {
    return handleFollowedUp(request, env, leadDoneMatch[1]);
  }

  if (path === '/api/opportunities' && method === 'GET') return handleListOpportunities(request, env);

  // ---- bookings ---------------------------------------------------------
  if (path === '/api/bookings' && method === 'GET') return handleListBookings(request, env);
  if (path === '/api/bookings' && method === 'POST') return handleCreateBooking(request, env);
  if (recordMatch && method === 'GET') return handleBookingRecord(request, env, recordMatch[1]);
  if (quickMatch && method === 'POST') return handleQuickUpdate(request, env, quickMatch[1]);
  // What the client is told, which is a narrow subset of what the record holds.
  if (statementMatch && method === 'POST') return handleStatement(request, env, statementMatch[1]);
  if (welcomedMatch && method === 'POST') return handleWelcomed(request, env, welcomedMatch[1]);

  // The paperwork a trip generates. Inert until an R2 bucket is bound.
  // Clearing an other-vendor row off a trip that still has one. Nothing adds
  // them any more: a second vendor is a second reservation.
  if (componentMatch && method === 'DELETE') return handleDeleteComponent(request, env, componentMatch[1]);

  if (docsMatch && method === 'POST') return handleUploadDocument(request, env, docsMatch[1]);
  if (docMatch && method === 'GET') return handleGetDocument(request, env, docMatch[1]);
  if (docMatch && method === 'DELETE') return handleDeleteDocument(request, env, docMatch[1]);

  // The two or three choices a quote offers, and which one the client took.
  if (optionsMatch && method === 'POST') return handleAddOption(request, env, optionsMatch[1]);
  if (chooseMatch && method === 'POST') return handleChooseOption(request, env, chooseMatch[1]);
  if (recommendMatch && method === 'POST') {
    return handleRecommendOption(request, env, recommendMatch[1]);
  }
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

  // ---- the bell ---------------------------------------------------------

  // What needs somebody, and what has arrived. Reading it changes nothing;
  // clearing it is the only write, and it writes one timestamp.
  if (path === '/api/alerts' && method === 'GET') return handleAlerts(request, env);
  if (path === '/api/alerts/seen' && method === 'POST') return handleAlertsSeen(request, env);

  // A notification on a device, with the tab closed. The key is public by
  // design: it is handed to every browser that subscribes.
  if (path === '/api/push/key' && method === 'GET') return handlePushKey(request, env);
  if (path === '/api/push/subscribe' && method === 'POST') {
    return handlePushSubscribe(request, env);
  }
  if (path === '/api/push/subscribe' && method === 'DELETE') {
    return handlePushUnsubscribe(request, env);
  }
  if (path === '/api/push/test' && method === 'POST') return handlePushTest(request, env);

  // ---- calendar ---------------------------------------------------------

  // Everything that happens on a day, from five places that each own one kind
  // of it. Read only: acting on any of it happens on the screen that owns it.
  if (path === '/api/calendar' && method === 'GET') return handleCalendar(request, env);

  // Chat: advisors and the agency, inside the portal.
  if (path === '/api/chat' && method === 'GET') return handleChat(request, env);
  // Before the messages routes, or "unread" and "read" are read as ids.
  if (path === '/api/chat/unread' && method === 'GET') return handleChatUnread(request, env);
  if (path === '/api/chat/thread' && method === 'GET') return handleRecordThread(request, env);
  if (path === '/api/chat/messages' && method === 'GET') {
    return handleChannelMessages(request, env);
  }
  if (path === '/api/chat/messages' && method === 'POST') {
    return handlePostMessage(request, env);
  }
  if (path === '/api/chat/read' && method === 'POST') return handleMarkRead(request, env);
  if (path === '/api/chat/channels' && method === 'POST') return handleCreateChannel(request, env);
  if (path === '/api/chat/dm' && method === 'POST') return handleOpenDm(request, env);
  const chatRoom = path.match(/^\/api\/chat\/channels\/([^/]+)\/closed$/);
  if (chatRoom && method === 'POST') return handleCloseRoom(request, env, chatRoom[1]);
  const chatMsg = path.match(/^\/api\/chat\/messages\/([^/]+)$/);
  if (chatMsg && method === 'PUT') return handleEditMessage(request, env, chatMsg[1]);
  if (chatMsg && method === 'DELETE') return handleDeleteMessage(request, env, chatMsg[1]);

  if (path === '/api/appointments' && method === 'GET') {
    return handleListAppointments(request, env);
  }
  if (path === '/api/appointments' && method === 'POST') {
    return handleCreateAppointment(request, env);
  }
  // A meeting somebody else typed. Before the /:id match, or "invite" is read
  // as an appointment id.
  if (path === '/api/appointments/invite' && method === 'POST') {
    return handleImportInvite(request, env);
  }
  // The address to forward invites to, and making one on request.
  if (path === '/api/appointments/address' && (method === 'GET' || method === 'POST')) {
    return handleInviteAddress(request, env, method === 'POST');
  }
  if (apptMatch && method === 'PUT') return handleUpdateAppointment(request, env, apptMatch[1]);
  if (apptMatch && method === 'DELETE') {
    return handleDeleteAppointment(request, env, apptMatch[1]);
  }


  // ---- forms and workflows ----------------------------------------------

  // Our own forms, built and hosted here.
  // An advisor's own form templates.
  if (path === '/api/form-templates' && method === 'GET') return handleListMyTemplates(request, env);
  if (path === '/api/form-templates' && method === 'POST') return handleSaveMyTemplate(request, env, null);
  if (myTplMatch && method === 'PUT') return handleSaveMyTemplate(request, env, myTplMatch[1]);
  if (myTplMatch && method === 'DELETE') return handleDeleteMyTemplate(request, env, myTplMatch[1]);

  if (path === '/api/myforms' && method === 'GET') return handleListOwnForms(request, env);
  // Before the /:id match, or "report" is read as a form id.
  if (path === '/api/myforms/report' && method === 'GET') return handleFormsReport(request, env);
  if (leadToBookingMatch && method === 'POST') {
    return handleReservationFromLead(request, env, leadToBookingMatch[1]);
  }
  if (path === '/api/myforms' && method === 'POST') return handleSaveForm(request, env, null);
  // Sending a form to one person, and asking afterwards what came of it.
  // Before the /:id match, or "send" is read as a form id.
  if (formSendMatch && method === 'POST') return handleSendForm(request, env, formSendMatch[1]);
  if (formInvitesMatch && method === 'GET') {
    return handleFormInvites(request, env, formInvitesMatch[1]);
  }
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

  // ---- dashboard and reports -------------------------------------------
  if (path === '/api/search' && method === 'GET') return handleSearch(request, env);

  // Tasks: the advisor's own working list, not the CRM's.
  // Sharing a trip with the person it is for.
  if (shareMatch && method === 'POST') return handleShareTrip(request, env, shareMatch[1]);
  if (clientHubMatch && method === 'POST') return handleShareClient(request, env, clientHubMatch[1]);
  // Before the single-segment match, which would read "rules" as an id.
  if (path === '/api/segments/rules' && method === 'GET') return handleSegmentRules(request, env);
  if (path === '/api/segments/preview' && method === 'POST') {
    return handleSegmentPreview(request, env);
  }
  if (path === '/api/segments' && method === 'GET') return handleListSegments(request, env);
  if (path === '/api/segments' && method === 'POST') return handleSaveSegment(request, env, null);
  if (segMatch && method === 'PUT') return handleSaveSegment(request, env, segMatch[1]);
  if (segMatch && method === 'DELETE') return handleDeleteSegment(request, env, segMatch[1]);

  // Before the single-broadcast match, which would read "preview" as an id.
  if (path === '/api/broadcasts/preview' && method === 'POST') {
    return handlePreviewBroadcast(request, env);
  }
  if (path === '/api/broadcasts' && method === 'GET') return handleListBroadcasts(request, env);
  if (path === '/api/broadcasts' && method === 'POST') return handleSaveBroadcast(request, env, null);
  if (castActMatch && method === 'POST') {
    const [, id, what] = castActMatch;
    if (what === 'test') return handleTestBroadcast(request, env, id);
    if (what === 'send') return handleSendBroadcast(request, env, id);
    return handleCancelBroadcast(request, env, id);
  }
  if (castMatch && method === 'GET') return handleGetBroadcast(request, env, castMatch[1]);
  if (castMatch && method === 'PUT') return handleSaveBroadcast(request, env, castMatch[1]);
  if (castMatch && method === 'DELETE') return handleDeleteBroadcast(request, env, castMatch[1]);

  if (path === '/api/suppressions' && method === 'GET') return handleListSuppressions(request, env);
  if (path === '/api/suppressions' && method === 'POST') return handleAddSuppression(request, env);
  if (path === '/api/suppressions/restore' && method === 'POST') {
    return handleRestoreSuppression(request, env);
  }

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

  // Whether the client may answer their own proposal.
  if (optionsOpenMatch && method === 'POST') {
    return handleOpenOptions(request, env, optionsOpenMatch[1]);
  }

  // Pieces of an itinerary, written once and dropped into any trip.
  if (path === '/api/itinerary-library' && method === 'GET') return handleListLibrary(request, env);
  if (path === '/api/itinerary-library' && method === 'POST') {
    return handleSaveLibraryPiece(request, env, null);
  }
  if (libMatch && method === 'PUT') return handleSaveLibraryPiece(request, env, libMatch[1]);
  if (libMatch && method === 'DELETE') return handleDeleteLibraryPiece(request, env, libMatch[1]);

  // The trip, day by day. from-library goes before the single-segment item
  // match, which would otherwise read "from-library" as an item id.
  if (itinUseMatch && method === 'POST') return handleUseLibraryPiece(request, env, itinUseMatch[1]);
  // Before the single-segment item match, which would read "reorder" as an id.
  if (itinOrderMatch && method === 'POST') {
    return handleReorderItinerary(request, env, itinOrderMatch[1]);
  }
  if (itinShareMatch && method === 'POST') {
    return handleShareItinerary(request, env, itinShareMatch[1]);
  }
  if (itinMatch && method === 'GET') return handleListItinerary(request, env, itinMatch[1]);
  if (itinMatch && method === 'POST') return handleSaveItem(request, env, itinMatch[1], null);
  if (itinItemMatch && method === 'PUT') {
    return handleSaveItem(request, env, itinItemMatch[1], itinItemMatch[2]);
  }
  if (itinItemMatch && method === 'DELETE') {
    return handleDeleteItem(request, env, itinItemMatch[1], itinItemMatch[2]);
  }

  // People who live at the same address, kept together.
  if (path === '/api/households' && method === 'GET') return handleListHouseholds(request, env);
  if (path === '/api/households' && method === 'POST') return handleCreateHousehold(request, env);
  if (path === '/api/households/suggestions' && method === 'GET') {
    return handleSuggestHouseholds(request, env);
  }
  // Before the single-segment match, which would otherwise swallow it.
  if (path === '/api/households/travellers' && method === 'GET') {
    return handleHouseholdTravellers(request, env);
  }
  if (houseMemberMatch && method === 'POST') return handleAddMember(request, env, houseMemberMatch[1]);
  if (houseDropMatch && method === 'DELETE') {
    return handleRemoveMember(request, env, houseDropMatch[1], houseDropMatch[2]);
  }
  if (houseMatch && method === 'GET') return handleHouseholdRecord(request, env, houseMatch[1]);
  if (houseMatch && method === 'PUT') return handleUpdateHousehold(request, env, houseMatch[1]);
  if (houseMatch && method === 'DELETE') return handleDeleteHousehold(request, env, houseMatch[1]);

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
  // Two records that are one person. Above the list so neither is shadowed by
  // a future /api/clients/:id matcher.
  if (path === '/api/clients/duplicates' && method === 'GET') return handleDuplicates(request, env);
  if (path === '/api/clients/merge' && method === 'POST') return handleMergeClients(request, env);
  if (path === '/api/clients' && method === 'GET') return handleListClients(request, env);
  if (path === '/api/clients' && method === 'POST') return handleCreateClient(request, env);
  if (path === '/api/import/preview' && method === 'POST') return handlePreviewImport(request, env);
  if (path === '/api/import/reservations' && method === 'POST') return handleRunImport(request, env);
  if (path === '/api/import/clients/preview' && method === 'POST') {
    return handlePreviewClientImport(request, env);
  }
  if (path === '/api/import/clients' && method === 'POST') return handleRunClientImport(request, env);

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

  // The last step of the money: what the agency paid the advisor. Recording
  // one is an owner's act, which the handler enforces rather than the router.
  if (path === '/api/payouts' && method === 'GET') return handleListPayouts(request, env);
  if (path === '/api/payouts' && method === 'POST') return handleCreatePayout(request, env);
  if (payoutMatch && method === 'DELETE') return handleDeletePayout(request, env, payoutMatch[1]);
  if (vendorStatementMatch && method === 'PUT') return handleUpdateStatement(request, env, vendorStatementMatch[1]);
  if (vendorStatementMatch && method === 'DELETE') return handleDeleteStatement(request, env, vendorStatementMatch[1]);
  if (path === '/api/commissions/status' && method === 'POST') {
    return handleSetCommissionStatus(request, env);
  }
  if (path === '/api/reports/production' && method === 'GET') return handleProduction(request, env);
  if (path === '/api/reports/attribution' && method === 'GET') return handleAttribution(request, env);
  if (path === '/api/reviews' && method === 'GET') return handleListReviews(request, env);
  const askReview = path.match(/^\/api\/bookings\/([^/]+)\/ask-review$/);
  if (askReview && method === 'POST') return handleAskReview(request, env, askReview[1]);
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

  // Agencies: who is on this portal, and what each of them looks like.
  // Whether the portal can reach the agency level at all, and what it could
  // copy. Before the single-segment match, which would otherwise swallow it.
  if (path === '/api/agencies' && method === 'GET') return handleListAgencies(request, env);
  if (path === '/api/agencies' && method === 'POST') return handleCreateAgency(request, env);
  if (agencyMatch && method === 'PUT') return handleUpdateAgency(request, env, agencyMatch[1]);
  if (advisorAgencyMatch && method === 'PUT') {
    return handleSetAdvisorAgency(request, env, advisorAgencyMatch[1]);
  }
  if (path === '/api/admin/lifecycle' && method === 'POST') return handleRunLifecycle(request, env);
  if (path === '/api/admin/advisors' && method === 'GET') return handleListAdvisors(request, env);
  // The only way an account comes into being. Nobody signs themselves up.
  if (path === '/api/admin/advisors' && method === 'POST') return handleCreateAdvisor(request, env);
  // Working inside an advisor's account. Stopping is deliberately not behind
  // requireAdmin: while acting, the session is an advisor, so an admin-only
  // route would be a door that locks from the inside.
  if (path === '/api/admin/act' && method === 'DELETE') return handleStopActing(request, env);
  if (bookingSplitMatch && method === 'PUT') {
    return handleSetBookingSplit(request, env, decodeURIComponent(bookingSplitMatch[1]));
  }
  if (bookingAdvisorMatch && method === 'PUT') {
    return handleSetBookingAdvisor(request, env, decodeURIComponent(bookingAdvisorMatch[1]));
  }
  if (actMatch && method === 'POST') {
    return handleStartActing(request, env, decodeURIComponent(actMatch[1]));
  }

  // A fresh set-password link. POST rather than PUT: each call mints a new
  // token rather than editing something that already exists.
  if (advisorMatch && advisorMatch[2] === 'invite' && method === 'POST') {
    return handleReissueInvite(request, env, decodeURIComponent(advisorMatch[1]));
  }

  // The advisor's own details. Before the suffixed matcher, which cannot
  // match this anyway, and after nothing: an id with no suffix had no route at
  // all and fell through to "no such endpoint".
  if (advisorOneMatch && method === 'PUT') {
    return handleUpdateAdvisor(request, env, decodeURIComponent(advisorOneMatch[1]));
  }

  if (advisorMatch && method === 'PUT') {
    const id = decodeURIComponent(advisorMatch[1]);
    if (advisorMatch[2] === 'status') return handleSetAdvisorStatus(request, env, id);
    if (advisorMatch[2] === 'split') return handleSetAdvisorSplit(request, env, id);
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

  // Unsubscribe, which is where every marketing footer points. Here with the
  // rest of what a client opens, rather than in routeApi where it spent its
  // whole life answering a static 404: routeApi only runs for /api/, so the
  // route was never reached. check-wiring asks now.
  //
  // Two steps, not one. A one-click link is fired by every scanner and preview
  // pane between the sender and the reader, so the GET asks and the POST does
  // it.
  const unsub = path.match(/^\/u\/([A-Za-z0-9._-]+)$/);
  if (unsub) {
    return request.method === 'POST'
      ? handleUnsubscribe(env, unsub[1])
      : renderUnsubscribe(env, unsub[1]);
  }

  // A client's own trip, on a code that is not the booking id. Read only: it
  // answers "what is booked, what have I paid, what is due", which otherwise
  // lives in an inbox. The POST is the note back, which is the only thing a
  // client can do here.
  const tripDoc = path.match(/^\/t\/([^/]+)\/d\/([^/]+)$/);
  if (tripDoc) {
    return serveTripDocument(request, env,
      decodeURIComponent(tripDoc[1]), decodeURIComponent(tripDoc[2]));
  }
  // The client answering "how was it", once they are home. Before the page
  // match, for the same reason /choose is.
  const tripReview = path.match(/^\/t\/([^/]+)\/review$/);
  if (tripReview && request.method === 'POST') {
    return handleTripReview(request, env, decodeURIComponent(tripReview[1]));
  }
  // The client answering their proposal. Before the page match, which would
  // otherwise read /choose as part of the code.
  const tripUpload = path.match(/^\/t\/([^/]+)\/upload$/);
  if (tripUpload && request.method === 'POST') {
    return handleTripUpload(request, env, decodeURIComponent(tripUpload[1]));
  }

  const tripChoose = path.match(/^\/t\/([^/]+)\/choose$/);
  if (tripChoose && request.method === 'POST') {
    return handleClientChoose(request, env, decodeURIComponent(tripChoose[1]));
  }

  // The other answer. Beside choosing, because the two are one question and
  // reading them apart is how one of them ends up behind a different fence.
  const tripDecline = path.match(/^\/t\/([^/]+)\/decline$/);
  if (tripDecline && request.method === 'POST') {
    return handleClientDecline(request, env, decodeURIComponent(tripDecline[1]));
  }
  // Before the trip page match, which is one segment and would not catch it
  // anyway; here so the two live together and neither is read as the other.
  const tripManifest = path.match(/^\/t\/([^/]+)\/app\.webmanifest$/);
  if (tripManifest) {
    return renderTripManifest(request, env, decodeURIComponent(tripManifest[1]));
  }

  const tripPage = path.match(/^\/t\/([^/]+)\/?$/);
  if (tripPage) {
    const tripCode = decodeURIComponent(tripPage[1]);
    return request.method === 'POST'
      ? handleTripMessage(request, env, tripCode)
      : renderTripPage(request, env, tripCode);
  }

  // The client portal. A second way in for somebody who would rather sign in
  // than keep a link, and the only one that can tell two people apart. Every
  // link already sent keeps working exactly as it did.
  if (path === '/portal' || path === '/portal/') {
    if (request.method === 'POST') return handlePortalSignIn(request, env);
    return renderPortal(request, env);
  }
  // Redeeming the emailed link. A GET because it is opened from an inbox, and
  // single use because the token is spent in the statement that checks it.
  if (path === '/portal/in') return handleClientLinkRedeem(request, env);
  if (path === '/portal/out' && request.method === 'POST') return handleClientSignOut(request, env);

  // One client's own page: every trip they have with us, on the same terms as
  // a single trip's page. The code is the credential.
  const hubPage = path.match(/^\/c\/([^/]+)\/?$/);
  if (hubPage) return renderHubPage(request, env, decodeURIComponent(hubPage[1]));

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
