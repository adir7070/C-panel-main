const facebookService = require("../services/facebook.service");
const aiService = require("../services/ai.service");
const { scoreAd } = require("../utils/adScoring");
const { copywriterSystemPrompt, constructUserPrompt } = require("../utils/adCopyPrompts");
const extractSiteContent = require("../utils/extractSiteContent");

exports.generateCopy = async (req, res) => {
  console.log("🚀 [Marketing] Generate Copy requested");
  try {
    const { access_token, actId, service, goal, site } = req.body;

    // 1. Validation
    if (!access_token || !actId) {
      return res.status(400).json({ error: "Missing access_token or actId" });
    }
    if (!service || !goal) {
      return res.status(400).json({ error: "Missing service or goal in payload" });
    }

    // 2. Fetch Ads
    console.log(`🔍 [Marketing] Fetching ads for account: ${actId}`);
    const ads = await facebookService.getAds(actId, access_token);
    console.log(`✅ [Marketing] Found ${ads.length} ads`);

    if (ads.length === 0) {
      return res.status(404).json({ error: "No ads found for this account" });
    }

    // 3. Fetch Insights (Concurrent batching)
    console.log("📊 [Marketing] Fetching insights...");
    // Limit to recent/active ads or just fetch all? The Make scenario fetched all.
    // Optimization: We can limit parallelism if needed, but Promise.all is usually fine for <100 items.
    // If ads > 100, we might want to chunk. For now, assuming reasonable size or standard node concurrency.
    
    // We only care about ads that have creative data, so filter first if needed.
    const validAds = ads.filter(ad => ad.creative);

    const insightsPromises = validAds.map(ad =>
      facebookService.getInsights(ad.id, access_token)
        .then(insight => ({ ...ad, insights: insight }))
        .catch(() => ({ ...ad, insights: null }))
    );

    const adsWithInsights = await Promise.all(insightsPromises);
    
    // 4. Score Ads
    console.log("Testing scoring logic...");
    const scoredAds = adsWithInsights.map(ad => {
      // Map flat insights structure to what scorer expects
      // Scorer expects: impressions, spend, inline_link_clicks, clicks, actions (array), quality_ranking...
      // These are all inside ad.insights
      
      const row = {
        ...ad.insights, 
        // If insights is null (no data), helper 'num' function handles undefined as 0
      };

      const score = scoreAd(row, 20); // targetCpl = 20 as per makefile
      
      return {
        id: ad.id,
        title: ad.creative?.title,
        body: ad.creative?.body,
        score: score
      };
    });

    // 5. Filter & Sort
    // "score >= 60"
    const highScoringAds = scoredAds.filter(a => a.score >= 60);
    console.log(`🏆 [Marketing] Ads with score >= 60: ${highScoringAds.length}`);

    // Sort Descending (Highest score first) - NOTE: Makefile sorted Ascending then slice(start), effectively taking top 3.
    // We will just sort Descending and take top 3.
    highScoringAds.sort((a, b) => b.score - a.score);
    
    const top3Ads = highScoringAds.slice(0, 3).map(ad => ({
      title: ad.title,
      body: ad.body,
      score: ad.score
    }));

    console.log("🔝 [Marketing] Top 3 Ads selected:", top3Ads);

    // 6. Generate Copy with AI
    console.log("🤖 [Marketing] Sending to AI...");
    const siteContext = site ? await extractSiteContent(site) : "";
    let userPrompt = constructUserPrompt({ service, goal, adsJson: top3Ads });
    if (siteContext) userPrompt += `\n\nהקשר מאתר העסק:\n${siteContext}`;

    const aiResult = await aiService.generateAdCopy(copywriterSystemPrompt, userPrompt);
    
    console.log("✨ [Marketing] Generation complete");

    // 7. Response
    res.json({
      success: true,
      data: aiResult,
      meta: {
        analyzed_ads: ads.length,
        qualified_ads: highScoringAds.length,
        top_scores: top3Ads.map(a => a.score)
      }
    });

  } catch (error) {
    console.error("❌ [Marketing] Error:", error.message);
    res.status(500).json({ 
        error: "Internal Processing Error", 
        details: error.message 
    });
  }
};
