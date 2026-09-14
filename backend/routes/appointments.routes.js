const express = require("express");
const router = express.Router();
const appointmentsController = require("../controllers/appointments.controller");

/**
 * @swagger
 * /api/appointments/customer:
 *   get:
 *     summary: Look up a customer in Fireberry by phone number
 *     description: |
 *       Queries Fireberry (Object Type 1 = Account/לקוח) by phone number.
 *       Tries three phone variants automatically: 972XXXXXXXXX, 0XXXXXXXXX, XXXXXXXXX.
 *       Returns the customer's accountid, name, and phone.
 *     tags: [Appointments]
 *     parameters:
 *       - in: query
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *           example: "0501234567"
 *         description: Customer phone number (any common Israeli format)
 *     responses:
 *       200:
 *         description: Customer found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     accountid:   { type: string, example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
 *                     accountname: { type: string, example: "ישראל ישראלי" }
 *                     telephone1:  { type: string, example: "0501234567" }
 *                     driveUrl:    { type: string, nullable: true, example: "https://drive.google.com/drive/folders/..." }
 *       400:
 *         description: Missing phone parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Customer not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Fireberry API error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/customer/search", appointmentsController.searchCustomers);
router.get("/customer", appointmentsController.getCustomerByPhone);
router.get("/upcoming", appointmentsController.getUpcomingAppointment);
router.get("/history", appointmentsController.getAppointmentHistory);
router.get("/cancelled", appointmentsController.getCancelledAppointments);

/**
 * @swagger
 * /api/appointments/available:
 *   get:
 *     summary: Get available 30-minute booking slots grouped by date and hour
 *     description: |
 *       Fetches booked meetings from Fireberry (Object Type 6) and returns the
 *       **free** 30-minute slots within working hours, grouped by date → hour block.
 *       Each hour block can have up to 2 slots (e.g. 09:00-09:30, 09:30-10:00).
 *       A slot is marked as taken if any booked meeting's start time falls within it.
 *       For today, slots in the past are automatically excluded.
 *       The `iso` field of each slot can be passed directly to `POST /api/appointments` as `scheduledStart`.
 *     tags: [Appointments]
 *     parameters:
 *       - in: query
 *         name: daysBefore
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Days before today to include (default 0)
 *       - in: query
 *         name: daysAhead
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Days ahead of today to include (default 1 = tomorrow)
 *       - in: query
 *         name: agentName
 *         schema:
 *           type: string
 *           example: "נציג 1"
 *         description: If `agentName` is provided, returns agent working hours 09:00-18:00. Without it, default hours are 10:00-16:00.
 *     responses:
 *       200:
 *         description: Available slots grouped by date and hour block
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   additionalProperties:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         hour: { type: string, example: "09:00-10:00" }
 *                         slots:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               start: { type: string, example: "09:00" }
 *                               end:   { type: string, example: "09:30" }
 *                               iso:   { type: string, example: "2026-02-24T07:00:00.000Z" }
 *       500:
 *         description: Fireberry API error or missing env variables
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/available", appointmentsController.getAvailableMeetings);
router.get("/month", appointmentsController.getMonthMeetings);
router.get("/week", appointmentsController.getWeekMeetings);

/**
 * @swagger
 * /api/appointments:
 *   post:
 *     summary: Create a new meeting in Fireberry
 *     description: |
 *       Creates a meeting record (Object Type 6) in the Fireberry CRM.
 *       The subject is auto-generated from the customer phone number.
 *       The resource and activity type are set to the system defaults.
 *     tags: [Appointments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMeetingInput'
 *     responses:
 *       201:
 *         description: Meeting created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   $ref: '#/components/schemas/Meeting'
 *       400:
 *         description: Missing or invalid input (customerPhone / scheduledStart)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Fireberry API error or missing env variables
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", appointmentsController.createAppointment);
router.post("/cancel", appointmentsController.cancelAppointmentByPhone);
router.post("/:phone/cancel", appointmentsController.cancelAppointmentByPhone);
router.patch("/:id/cancel", appointmentsController.cancelAppointment);
router.patch("/:id/restore", appointmentsController.restoreAppointment);
router.patch("/:id/update", appointmentsController.updateAppointmentStatus);

module.exports = router;
