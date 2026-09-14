const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Iconiq Server API",
      version: "1.0.0",
      description:
        "API documentation for the Iconiq server — leads, AI, auth, WhatsApp, Instagram, payments and more.",
    },
    servers: [
      {
        url: process.env.BASE_URL || "http://localhost:3900",
        description: "Active server",
      },
    ],
    tags: [
      { name: "Leads", description: "Lead management (CRUD, stats, batch)" },
      {
        name: "Posts",
        description: "Draft Facebook campaign posts per page_id",
      },
      {
        name: "AI",
        description: "AI text & image generation (Gemini / OpenAI)",
      },
      { name: "Auth", description: "OTP authentication via WhatsApp" },
      { name: "WhatsApp", description: "WhatsApp messaging via Green API" },
      { name: "Instagram", description: "Instagram post generation" },
      { name: "Payment", description: "Payment page creation" },
      { name: "Invoice", description: "Invoice creation and download" },
      {
        name: "Gallery",
        description: "Customer image gallery via Backblaze proxy",
      },
      {
        name: "Appointments",
        description: "Meeting management via Fireberry CRM (Object Type 6)",
      },
    ],
    components: {
      schemas: {
        Lead: {
          type: "object",
          properties: {
            _id: { type: "string", example: "65f1a2b3c4d5e6f7a8b9c0d1" },
            page_id: { type: "string", example: "123456789" },
            account_id: { type: "string", example: "act_123456789" },
            name: { type: "string", example: "ישראל ישראלי" },
            email: { type: "string", example: "israel@example.com" },
            phone: { type: "string", example: "0501234567" },
            status: {
              type: "string",
              enum: ["new", "in_progress", "closed", "rejected", "not_closed"],
              example: "new",
            },
            custom_fields: {
              type: "object",
              example: { city: "תל אביב", service: "אינסטלציה" },
            },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        Post: {
          type: "object",
          properties: {
            _id: { type: "string", example: "65f1a2b3c4d5e6f7a8b9c0d1" },
            page_id: { type: "string", example: "123456789" },
            status: {
              type: "string",
              enum: ["draft", "executed"],
              example: "draft",
            },
            campaign: { $ref: "#/components/schemas/Campaign" },
            ad_set: { $ref: "#/components/schemas/AdSet" },
            ads: { type: "array", items: { $ref: "#/components/schemas/Ad" } },
            campaign_settings: {
              $ref: "#/components/schemas/CampaignSettings",
            },
            form: { $ref: "#/components/schemas/LeadForm" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            executed_at: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
          },
        },
        Campaign: {
          type: "object",
          properties: {
            id: { type: "string", example: "472938105" },
            account_id: { type: "string", example: "act_123456789" },
            page_id: { type: "string", nullable: true },
            title: { type: "string", example: "שירותי אינסטלציה מקצועיים" },
            status: { type: "string", example: "active" },
            is_active: { type: "integer", enum: [0, 1] },
            is_demo: { type: "integer", enum: [0, 1] },
            job_id: { type: "string", example: "job_abc123" },
            spend_today: { type: "number", example: 127.5 },
            leads_today: { type: "integer", example: 11 },
            cpa: { type: "number", example: 11.59 },
            spend_total: { type: "number", example: 127.5 },
            leads_total: { type: "integer", example: 11 },
            service_image_url: { type: "string", format: "uri" },
          },
        },
        AdSet: {
          type: "object",
          properties: {
            id: { type: "string", example: "831045720" },
            campaign_id: { type: "string", example: "472938105" },
            name: { type: "string", example: "קהל שמתכונן..." },
            budget_daily: { type: "number", example: 50 },
            status: { type: "integer", enum: [0, 1] },
            effective_status: { type: "string", example: "ACTIVE" },
            billing_event: { type: "string", example: "IMPRESSIONS" },
            optimization_goal: { type: "string", example: "LEAD_GENERATION" },
            targeting: {
              type: "object",
              properties: {
                age_min: { type: "integer", example: 30 },
                age_max: { type: "integer", example: 60 },
                genders: {
                  type: "array",
                  items: { type: "integer" },
                  example: [1],
                },
                geo_locations: {
                  type: "object",
                  properties: {
                    countries: {
                      type: "array",
                      items: { type: "string" },
                      example: ["IL"],
                    },
                  },
                },
              },
            },
          },
        },
        Ad: {
          type: "object",
          properties: {
            id: { type: "string", example: "561820394" },
            adset_id: { type: "string", example: "831045720" },
            campaign_id: { type: "string", example: "472938105" },
            name: { type: "string", example: "מודעה 1" },
            status: { type: "integer", enum: [0, 1] },
            effective_status: { type: "string", example: "ACTIVE" },
            creative_image_url: { type: "string", format: "uri" },
            creative_thumbnail_url: { type: "string", format: "uri" },
            link_name: { type: "string", example: "כותרת המודעה" },
            link_message: { type: "string", example: "טקסט המודעה" },
            link_description: { type: "string", example: "תיאור" },
            link_cta_type: { type: "string", example: "LEARN_MORE" },
            results_total: { type: "number", example: 3 },
            spend_total: { type: "number", example: 22.1 },
            leads_total: { type: "integer", example: 3 },
            created_time: { type: "string", format: "date-time" },
            updated_time: { type: "string", format: "date-time" },
          },
        },
        CampaignSettings: {
          type: "object",
          properties: {
            budget_daily: { type: "number", example: 50 },
            interests: {
              type: "array",
              items: { type: "string" },
              example: ["בית ועיצוב"],
            },
            ad_text: { type: "string", example: "טקסט המודעה הכללי" },
            image_urls: {
              type: "array",
              items: { type: "string", format: "uri" },
            },
            lead_form_id: {
              type: "string",
              example: "demo_form_1707739200000",
            },
            age_min: { type: "integer", example: 30 },
            age_max: { type: "integer", example: 60 },
            locations_include: {
              type: "array",
              items: { type: "string" },
              example: ["תל אביב", "רמת גן"],
            },
            locations_exclude: {
              type: "array",
              items: { type: "string" },
              example: [],
            },
            gender: {
              type: "string",
              enum: ["all", "male", "female"],
              example: "all",
            },
          },
        },
        LeadForm: {
          type: "object",
          properties: {
            id: { type: "string", example: "demo_form_1707739200000" },
            campaign_id: { type: "string", example: "472938105" },
            name: { type: "string", example: "טופס לידים 12.2.2026" },
            created_time: { type: "string", format: "date-time" },
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["FULL_NAME", "PHONE", "EMAIL", "CITY", "CUSTOM"],
                    example: "CUSTOM",
                  },
                  label: { type: "string", example: "מה הבעיה שלך?" },
                  key: { type: "string", example: "q_abc123" },
                  options: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        key: { type: "string", example: "נזילה" },
                        value: { type: "string", example: "נזילה" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        Meeting: {
          type: "object",
          properties: {
            id: {
              type: "string",
              example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
            subject: {
              type: "string",
              example: "פגישה ללקוח -\n - המספר שלו הוא 0501234567",
            },
            scheduledstart: {
              type: "string",
              format: "date-time",
              example: "2026-02-25T10:00:00.000Z",
            },
            scheduledend: {
              type: "string",
              format: "date-time",
              example: "2026-02-25T11:00:00.000Z",
            },
            zoomLink: {
              type: "string",
              nullable: true,
              example: "https://zoom.us/j/123456789",
            },
            resource: {
              type: "string",
              example: "01fa95e1-feed-4998-a2bc-af31f654ed48",
            },
            resourceName: {
              type: "string",
              nullable: true,
              example: "נציג מכירות",
            },
            status: { type: "integer", example: 1 },
            owner: {
              type: "string",
              example: "01fa95e1-feed-4998-a2bc-af31f654ed48",
            },
          },
        },
        CreateMeetingInput: {
          type: "object",
          required: ["customerPhone", "scheduledStart"],
          properties: {
            customerPhone: {
              type: "string",
              example: "0501234567",
              description: "מספר הטלפון של הלקוח",
            },
            scheduledStart: {
              type: "string",
              format: "date-time",
              example: "2026-02-25T10:00:00.000Z",
              description: "תאריך ושעת תחילת הפגישה (ISO 8601)",
            },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "page_id is required" },
            details: { type: "string", example: "..." },
          },
        },
        Success: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
          },
        },
      },
    },
  },
  apis: ["./routes/*.js"],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
