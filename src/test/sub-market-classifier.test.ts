import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK so unit tests don't hit the real API.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

import {
  classifySubMarket,
  SUB_MARKETS,
  CLASSIFIER_VERSION,
  type ClassifierInput,
} from "../lib/sub-market-classifier.js";

beforeEach(() => {
  mockCreate.mockReset();
});

describe("classifySubMarket - TLD hard rules", () => {
  it("classifies .edu as Not SLED (institution, not vendor)", async () => {
    const result = await classifySubMarket({ domain: "stanford.edu" });
    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("tld");
    expect(result.confidence).toBe("high");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("classifies .gov as Not SLED (institution, not vendor)", async () => {
    const result = await classifySubMarket({ domain: "ed.gov" });
    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("tld");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("classifies .mil as Not SLED (institution, not vendor)", async () => {
    const result = await classifySubMarket({ domain: "army.mil" });
    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("tld");
  });

  it("classifies .k12.* as Not SLED (school district, not vendor)", async () => {
    const result = await classifySubMarket({ domain: "lausd.k12.ca.us" });
    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("tld");
  });

  it("does NOT classify .com domains by TLD", async () => {
    const result = await classifySubMarket({ domain: "example.com" });
    expect(result.source).toBe("default");
    expect(result.sub_market).toBe("Not SLED");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("classifySubMarket - industry keyword hard rules", () => {
  it("does NOT hard-rule 'Higher Education' industry (delegates to Claude)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "classify_sub_market",
          input: {
            sub_market: "Higher Ed",
            confidence: "high",
            reason: "Description confirms Harvard is a research university",
          },
        },
      ],
    });

    const result = await classifySubMarket({
      domain: "harvard.com",
      industry: "Higher Education",
      description: "Harvard University is a private Ivy League research university",
    });
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result.sub_market).toBe("Higher Ed");
    expect(result.source).toBe("claude");
  });

  it("classifies 'Hospitals and Health Care' as Not SLED", async () => {
    const result = await classifySubMarket({
      domain: "kaiser.org",
      industry: "Hospitals and Health Care",
    });
    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("industry_keyword");
  });

  it("classifies 'Banking' as Not SLED", async () => {
    const result = await classifySubMarket({
      domain: "chase.com",
      industry: "Banking",
    });
    expect(result.sub_market).toBe("Not SLED");
  });

  it("classifies 'Government Administration' as Not SLED (institution, not vendor)", async () => {
    const result = await classifySubMarket({
      domain: "doc.state.fl.us",
      industry: "Government Administration",
    });
    expect(result.sub_market).toBe("Not SLED");
  });

  it("classifies 'Retail' as Not SLED", async () => {
    const result = await classifySubMarket({
      domain: "target.com",
      industry: "Retail",
    });
    expect(result.sub_market).toBe("Not SLED");
  });

  it("does NOT hard-rule 'E-Learning' (delegates to Claude)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "classify_sub_market",
          input: {
            sub_market: "Not SLED",
            confidence: "high",
            reason: "Corporate compliance training, not sold to K-12 or Higher Ed",
          },
        },
      ],
    });

    const result = await classifySubMarket({
      domain: "oncourselearning.com",
      industry: "E-learning",
      description: "Mortgage and financial compliance training for institutions",
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("claude");
  });

  it("does NOT hard-rule 'Education Management' (delegates to Claude)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "classify_sub_market",
          input: {
            sub_market: "K12 EdTech SaaS",
            confidence: "high",
            reason: "Charter school network that contracts with K-12 districts",
          },
        },
      ],
    });

    const result = await classifySubMarket({
      domain: "kipp.org",
      industry: "Education Management",
      description: "KIPP is a national network of charter schools",
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result.source).toBe("claude");
  });
});

describe("classifySubMarket - Claude fallback", () => {
  it("calls Claude with structured tool-use for ambiguous E-learning", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "classify_sub_market",
          input: {
            sub_market: "K12 EdTech SaaS",
            confidence: "high",
            reason: "Description mentions K-12 districts and curriculum",
          },
        },
      ],
    });

    const input: ClassifierInput = {
      domain: "peardeck.com",
      name: "Pear Deck",
      industry: "E-learning",
      description: "Pear Deck is an interactive presentation tool used by K-12 teachers in classrooms",
      employee_count: 75,
    };

    const result = await classifySubMarket(input);

    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-4-5-20251001");
    expect(call.tools[0].name).toBe("classify_sub_market");
    expect(call.tool_choice).toEqual({ type: "tool", name: "classify_sub_market" });

    expect(result.sub_market).toBe("K12 EdTech SaaS");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("claude");
    expect(result.version).toBe(CLASSIFIER_VERSION);
  });

  it("returns Not SLED when Claude API fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API timeout"));

    const result = await classifySubMarket({
      domain: "unknown.com",
      industry: "E-learning",
      description: "A company",
    });

    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("claude");
    expect(result.reason).toContain("API timeout");
  });

  it("returns Not SLED when Claude returns invalid enum", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "classify_sub_market",
          input: {
            sub_market: "Some Made Up Category",
            confidence: "high",
            reason: "Hallucinated",
          },
        },
      ],
    });

    const result = await classifySubMarket({
      domain: "example.com",
      industry: "E-learning",
      description: "A company",
    });

    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("claude");
  });

  it("uses scraped_text as input when description is missing", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "classify_sub_market",
          input: {
            sub_market: "Higher Ed",
            confidence: "high",
            reason: "Scraped homepage describes a community college",
          },
        },
      ],
    });

    const result = await classifySubMarket({
      domain: "examplecollege.org",
      scraped_text:
        "Welcome to Example Community College, a two-year public institution serving 5,000 students across three campuses in central California. We offer associate degrees, transfer programs to four-year universities, and workforce certificates in nursing, automotive technology, and culinary arts.",
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result.sub_market).toBe("Higher Ed");
  });
});

describe("classifySubMarket - insufficient data", () => {
  it("returns Not SLED when no description, scraped text, or industry", async () => {
    const result = await classifySubMarket({
      domain: "mystery.io",
    });
    expect(result.sub_market).toBe("Not SLED");
    expect(result.source).toBe("default");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("SUB_MARKETS enum integrity", () => {
  it("contains exactly 4 SLED-focused categories", () => {
    expect(SUB_MARKETS).toHaveLength(4);
  });

  it("includes all 3 SLED verticals + Not SLED", () => {
    expect(SUB_MARKETS).toContain("K12 EdTech SaaS");
    expect(SUB_MARKETS).toContain("Higher Ed");
    expect(SUB_MARKETS).toContain("Government & Public Sector");
    expect(SUB_MARKETS).toContain("Not SLED");
  });
});
