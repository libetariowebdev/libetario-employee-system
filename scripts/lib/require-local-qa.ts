if (process.env.NODE_ENV === "production")
  throw new Error("QA fixtures are forbidden in production");
