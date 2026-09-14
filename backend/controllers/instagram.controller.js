const instagramService = require("../services/instagram.service");

exports.createPost = async (req, res) => {
  console.log("createPost called with body:", req.body);

  try {
    const data = req.body;

    // Basic validation
    if (!data.subject || (!data.platform && !data.postType)) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields: subject, and either platform or postType",
      });
    }

    const result = await instagramService.generatePost(data);

    res.status(200).json({
      success: true,
      message: "Post generation started",
      data: result,
    });
  } catch (error) {
    console.error("Error in createPost controller:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error",
    });
  }
};

exports.getJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await instagramService.getJob(jobId);

    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    res.status(200).json({ success: true, data: job });
  } catch (error) {
    console.error("Error in getJobStatus:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
