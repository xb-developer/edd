import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same pattern as auth.test.ts's own resolveOrgContext tests — the
// Auth0-JWT verification half (requireValidToken) is the library's job,
// not this app's, so req.auth.payload is injected directly rather than
// carrying a real JWT through supertest.
vi.mock("../auth0Management.js", () => ({
  getUserOrganizationIds: vi.fn(),
}));
import { getUserOrganizationIds } from "../auth0Management.js";
import { myOrganizationsRouter } from "./myOrganizations.js";

function buildTestApp(payload: { sub?: string }) {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { payload } as unknown as express.Request["auth"];
    next();
  });
  app.use("/api/my-organizations", myOrganizationsRouter);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

describe("GET /api/my-organizations", () => {
  beforeEach(() => {
    vi.mocked(getUserOrganizationIds).mockReset();
  });

  it("returns the organization ids Auth0 reports for this token's sub claim", async () => {
    const auth0UserId = `auth0|${randomUUID()}`;
    vi.mocked(getUserOrganizationIds).mockResolvedValue(["org_abc123"]);

    const app = buildTestApp({ sub: auth0UserId });
    const response = await request(app).get("/api/my-organizations").send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organizationIds: ["org_abc123"] });
    expect(getUserOrganizationIds).toHaveBeenCalledWith(auth0UserId);
  });

  it("returns an empty list as-is — the client decides what zero organizations means", async () => {
    vi.mocked(getUserOrganizationIds).mockResolvedValue([]);
    const app = buildTestApp({ sub: `auth0|${randomUUID()}` });
    const response = await request(app).get("/api/my-organizations").send();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organizationIds: [] });
  });

  it("401s when the token is missing the sub claim", async () => {
    const app = buildTestApp({});
    const response = await request(app).get("/api/my-organizations").send();
    expect(response.status).toBe(401);
    expect(getUserOrganizationIds).not.toHaveBeenCalled();
  });
});
