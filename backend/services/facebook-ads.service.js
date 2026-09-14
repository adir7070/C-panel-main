'use strict';

/**
 * Facebook Ads creation helpers — used after campaign-brief image generation.
 *
 * Flow:
 *   1. createCampaign  — ACTIVE, CBO budget at campaign level (20 ILS/day)
 *   2. createAdSet     — ACTIVE, no per-adset budget (CBO controls it)
 *   3. createLeadForm  — simple name+phone form (leads campaigns only)
 *   4. uploadAdImage   — upload by public URL → returns image_hash
 *   5. createAdCreative — link_data with image + headline + body + CTA
 *   6. createAd        — PAUSED ad linked to adset + creative
 */

const axios    = require('axios');
const FormData = require('form-data');
const backblaze = require('./backblaze.service');

const FB_API_VERSION = process.env.FACEBOOK_API_VERSION || 'v23.0';
const BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

// ─── 1. Campaign (CBO, ACTIVE, 20 ILS/day) ───────────────────────────────────

async function createCampaign(userToken, actId, name, campaignType) {
  const objective = campaignType === 'leads' ? 'OUTCOME_LEADS' : 'OUTCOME_TRAFFIC';
  try {
    const { data } = await axios.post(`${BASE}/${actId}/campaigns`, null, {
      params: {
        name,
        objective,
        status: 'ACTIVE',
        special_ad_categories: JSON.stringify([]),
        daily_budget: '2000',          // 20 ILS in agorot (string per FB API)
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        access_token: userToken,
      },
    });
    console.log(`[FbAds] ✅ campaign created: ${data.id} — "${name}"`);
    return data.id;
  } catch (err) {
    throw new Error(`createCampaign failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

// ─── 2. Ad Set (ACTIVE, linked to campaign, no budget) ───────────────────────

async function createAdSet(userToken, actId, campaignId, pageId, campaignType) {
  const isLeads = campaignType === 'leads';
  const params = {
    name: `AdSet-${Date.now()}`,
    campaign_id: campaignId,
    billing_event: 'IMPRESSIONS',
    optimization_goal: isLeads ? 'LEAD_GENERATION' : 'LINK_CLICKS',
    status: 'ACTIVE',
    targeting: JSON.stringify({
      geo_locations: { countries: ['IL'] },
      age_min: 18,
      age_max: 65,
    }),
    access_token: userToken,
  };
  if (isLeads) {
    params.destination_type = 'ON_AD';
    params.promoted_object = JSON.stringify({ page_id: pageId });
  }
  try {
    const { data } = await axios.post(`${BASE}/${actId}/adsets`, null, { params });
    console.log(`[FbAds] ✅ adset created: ${data.id}`);
    return data.id;
  } catch (err) {
    throw new Error(`createAdSet failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

// ─── 3. Lead Form (name + phone, simple) ────────────────────────────────────

async function createLeadForm(pageToken, pageId, formName, privacyUrl) {
  const resolvedPrivacyUrl = privacyUrl || 'https://iconiqmedia.co.il';
  try {
    const { data } = await axios.post(`${BASE}/${pageId}/leadgen_forms`, null, {
      params: {
        name: formName,
        questions: JSON.stringify([{ type: 'FULL_NAME' }, { type: 'PHONE' }]),
        privacy_policy: JSON.stringify({ url: resolvedPrivacyUrl }),
        follow_up_action_url: resolvedPrivacyUrl,
        locale: 'he_IL',
        access_token: pageToken,
      },
    });
    console.log(`[FbAds] ✅ lead form created: ${data.id}`);
    return data.id;
  } catch (err) {
    throw new Error(`createLeadForm failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

// ─── 4. Upload image BYTES (multipart) → image_hash ──────────────────────────
// IMPORTANT: we upload the raw image BYTES, NOT the `url` param. FB's
// /adimages url-upload requires a special app capability ("Ads Management
// Standard Access") our app does not hold — passing `url` returns
// "(#3) Application does not have the capability to make this API call",
// which leaves the campaign with zero ads. Uploading bytes works with the
// standard ads_management permission. This mirrors the proven WOW Ads launch
// flow (cpanel launchFacebookCampaign) byte-for-byte.

async function uploadAdImage(userToken, actId, publicImageUrl) {
  try {
    // 1) Get the image bytes. When the URL is our own /api/img?url=<b2Path>
    //    proxy, pull the bytes straight from Backblaze (no extra HTTP hop and
    //    independent of SERVER_BASE_URL); otherwise fetch the URL directly.
    let imgBuffer, contentType;
    const proxyMatch = /[?&]url=([^&]+)/.exec(publicImageUrl || '');
    if (publicImageUrl && publicImageUrl.includes('/api/img') && proxyMatch) {
      const b2Path = decodeURIComponent(proxyMatch[1]);
      const r = await backblaze.downloadImageByPath(b2Path);
      imgBuffer   = r.buffer;
      contentType = r.contentType || 'image/png';
    } else {
      const r = await axios.get(publicImageUrl, { responseType: 'arraybuffer' });
      imgBuffer   = Buffer.from(r.data);
      contentType = r.headers['content-type'] || 'image/png';
    }
    if (!imgBuffer || !imgBuffer.length) throw new Error('could not fetch image bytes');

    // 2) Upload the bytes as multipart/form-data.
    const ext      = (contentType.split('/')[1] || 'png').split(';')[0];
    const filename = `image.${ext}`;
    const form = new FormData();
    form.append(filename, imgBuffer, { filename, contentType });
    form.append('access_token', userToken);

    const { data } = await axios.post(`${BASE}/${actId}/adimages`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    const key  = Object.keys(data.images || {})[0];
    const hash = data.images?.[key]?.hash;
    if (!hash) throw new Error('no image hash returned');
    console.log(`[FbAds] ✅ image uploaded (bytes), hash: ${hash}`);
    return hash;
  } catch (err) {
    throw new Error(`uploadAdImage failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

// ─── 5a. Ad Creative — Lead Gen ─────────────────────────────────────────────

async function createLeadsCreative(userToken, pageId, actId, imageHash, adContent, formId, websiteUrl) {
  const body = [adContent.subheadline, adContent.proof_line].filter(Boolean).join('\n');
  // FB policy 1815316: a Lead Generation ad creative MUST carry an external
  // link (never a facebook.com URL), even though the instant form opens
  // on-platform. Omitting it returns "Invalid parameter" (#100) and the
  // campaign goes live with zero ads. Fall back to the agency domain.
  const link = websiteUrl || 'https://iconiqmedia.co.il';
  try {
    const { data } = await axios.post(`${BASE}/${actId}/adcreatives`, null, {
      params: {
        name: `Creative-${Date.now()}`,
        object_story_spec: JSON.stringify({
          page_id: pageId,
          link_data: {
            image_hash: imageHash,
            link,
            message: body,
            name: adContent.headline,
            call_to_action: {
              type: 'SIGN_UP',
              value: { lead_gen_form_id: formId },
            },
          },
        }),
        access_token: userToken,
      },
    });
    return data.id;
  } catch (err) {
    const fb = err.response?.data?.error;
    const detail = fb
      ? [fb.message, fb.error_user_title, fb.error_user_msg, fb.error_subcode && `subcode ${fb.error_subcode}`]
          .filter(Boolean).join(' | ')
      : err.message;
    throw new Error(`createLeadsCreative failed: ${detail}`);
  }
}

// ─── 5b. Ad Creative — Traffic (website) ────────────────────────────────────

async function createTrafficCreative(userToken, pageId, actId, imageHash, adContent, websiteUrl) {
  const body = [adContent.subheadline, adContent.proof_line].filter(Boolean).join('\n');
  try {
    const { data } = await axios.post(`${BASE}/${actId}/adcreatives`, null, {
      params: {
        name: `Creative-${Date.now()}`,
        object_story_spec: JSON.stringify({
          page_id: pageId,
          link_data: {
            image_hash: imageHash,
            link: websiteUrl,
            message: body,
            name: adContent.headline,
            call_to_action: {
              type: 'LEARN_MORE',
              value: { link: websiteUrl },
            },
          },
        }),
        access_token: userToken,
      },
    });
    return data.id;
  } catch (err) {
    throw new Error(`createTrafficCreative failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

// ─── 6. Ad (PAUSED) ──────────────────────────────────────────────────────────

async function createAd(userToken, actId, adsetId, creativeId, adName) {
  try {
    const { data } = await axios.post(`${BASE}/${actId}/ads`, null, {
      params: {
        name: adName,
        adset_id: adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: 'PAUSED',
        access_token: userToken,
      },
    });
    console.log(`[FbAds] ✅ ad created (PAUSED): ${data.id}`);
    return data.id;
  } catch (err) {
    throw new Error(`createAd failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

module.exports = {
  createCampaign,
  createAdSet,
  createLeadForm,
  uploadAdImage,
  createLeadsCreative,
  createTrafficCreative,
  createAd,
};
