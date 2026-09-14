const express = require("express");
const multer = require("multer");
const router = express.Router();
const c = require("../controllers/agent.controller");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Admin / manager (CPANEL) surface for the AI account-manager agent.
// SECURITY: these were tokenless (admin/testing-era); now READS require any
// authenticated staff agent, and POWER actions (run/approve/kill-switch/
// proactive/distill) require the owner. No UI consumed them unauthenticated.
router.get("/status", c.requireAgent, c.status);                // { agentEnabled }
router.post("/run", c.requireOwner, c.run);                     // { phone, message, mode } — manual run / dry run
router.get("/actions", c.requireAgent, c.getActions);           // ?phone= &runId= &status= — audit trail
router.get("/approvals", c.requireAgent, c.listApprovals);      // ?phone= — pending approvals queue
router.post("/approve", c.requireOwner, c.approve);             // { approvalId, approver }
router.post("/reject", c.requireOwner, c.reject);               // { approvalId, approver }
router.post("/kill-switch", c.requireOwner, c.killSwitch);      // { enabled } — global on/off
router.post("/proactive/sweep", c.requireOwner, c.proactiveSweep);  // { force } — run the proactive sweep now
router.post("/proactive/one", c.requireOwner, c.proactiveOne);      // { phone, force, nowHour } — one client
router.post("/distill", c.requireOwner, c.distill);                 // { dryRun } — shadow-learn the brain from manager chats
router.get("/brain", c.requireAgent, c.getBrain);                   // view the active distilled brain
router.get("/lessons", c.requireOwner, c.getLessons);            // ?all=1&limit= — live-learned lessons (ADMIN-BOSS)
router.post("/lessons/deactivate", c.requireOwner, c.deactivateLesson); // { id } — retire a bad lesson
router.post("/reflect", c.requireOwner, c.reflectNow);           // run nightly reflection now (background)
router.post("/style-index", c.requireOwner, c.styleIndexNow);    // rebuild the style-RAG index now (background)
router.get("/client-memory/:phone", c.requireAgent, c.getClientMemory);        // long-term client facts (staff)
router.post("/client-memory/deactivate", c.requireOwner, c.deactivateClientFact); // { phone, id } — retire a wrong fact
router.get("/quality", c.requireOwner, c.getQualityScores);      // nightly judge scores (trend)
router.post("/quality/judge", c.requireOwner, c.judgeNow);       // run the quality judge now (background)
router.get("/benchmarks", c.requireOwner, c.getBenchmarks);      // internal pooled CPL benchmarks
router.get("/ops/preview", c.requireOwner, c.opsPreview);        // dryRun: what the autonomy loops WOULD do
router.post("/ops/run", c.requireOwner, c.opsRunNow);            // run the autonomy loops now (background)
router.get("/escalations", c.requireOwner, c.getEscalations);       // ?status=open&phone= — ADMIN-BOSS only
router.post("/escalations/resolve", c.requireOwner, c.resolveEscalation); // { id, by } — ADMIN-BOSS only
router.post("/escalations/forward", c.requireOwner, c.forwardEscalation); // { id } — hand to manager Noy's inbox (ADMIN-BOSS only)
router.get("/tech-report", c.requireOwner, c.getTechReport);        // ?days= &force= — agent's technical-issues + code-fix report (ADMIN-BOSS)
router.post("/tech-report/resolve", c.requireOwner, c.resolveTechIssue); // { tool, errorPrefix } — auto re-run failed client requests (ADMIN-BOSS)

// Human takeover of the AI thread (any authenticated staff agent)
router.get("/manager/threads", c.requireAgent, c.getManagerThreads);      // ?handling=human — threads to handle
router.post("/manager/takeover", c.requireAgent, c.takeOverChat);          // { phone } — pause AI, take the thread
router.post("/manager/return", c.requireAgent, c.returnChatToAi);          // { phone } — hand back to the AI
router.post("/manager/close", c.requireAgent, c.closeChat);                // { phone } — resolve/close the thread (→ "סגור")
router.post("/manager/send", c.requireAgent, c.sendHumanChatMessage);      // { phone, text } — reply to the client in-thread
router.post("/manager/send-image", c.requireAgent, upload.single("image"), c.sendHumanChatImage); // { phone, image(file), caption? } — send an image to the client
router.post("/manager/send-document", c.requireAgent, upload.single("document"), c.sendHumanChatDocument); // { phone, document(PDF file), caption? } — Noy sends a document (invoice) to the client
router.get("/manager/client-report/:phone", c.requireAgent, c.getClientReport); // client 360: report + creatives + escalations + debug

module.exports = router;
