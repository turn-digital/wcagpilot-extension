// run-axe.js — injicē aktīvajā lapā pēc axe-core.min.js ielādes
// Palaiž axe-core analīzi un atgriež saīsinātu rezultātu (bez lieka detalizācijas)
(async () => {
  try {
    // Pārbauda vai axe ir pieejams
    if (typeof axe === "undefined") {
      return { error: "axe-core nav ielādēts" };
    }

    // Palaiž axe analīzi ar noklusējuma noteikumiem
    const results = await axe.run(document, {
      // Izmanto visus noklusējuma noteikumus
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
      },
      // Ierobežo rezultātus lai samazinātu datu apjomu
      resultTypes: ["violations", "incomplete"],
    });

    // Saīsina rezultātus — saglabā tikai būtisko informāciju
    const summarizeNodes = (nodes) => {
      // Ierobežo līdz 5 piemēriem katrai problēmai
      return nodes.slice(0, 5).map((node) => ({
        html: node.html?.substring(0, 200), // Saīsina HTML fragmentu
        target: node.target, // CSS selektors
        failureSummary: node.failureSummary,
      }));
    };

    const violations = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact, // "critical", "serious", "moderate", "minor"
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags, // WCAG kritēriji, piem. ["wcag2aa", "wcag143"]
      nodes: summarizeNodes(v.nodes),
      nodeCount: v.nodes.length, // Kopējais skaits (var būt > 5)
    }));

    const incomplete = results.incomplete.map((i) => ({
      id: i.id,
      impact: i.impact,
      description: i.description,
      help: i.help,
      helpUrl: i.helpUrl,
      tags: i.tags,
      nodes: summarizeNodes(i.nodes),
      nodeCount: i.nodes.length,
    }));

    return {
      timestamp: results.timestamp,
      url: results.url,
      violations: violations,
      incomplete: incomplete,
      // Kopsavilkums
      summary: {
        violationCount: results.violations.length,
        incompleteCount: results.incomplete.length,
        // Grupē pēc impact līmeņa
        byImpact: {
          critical: violations.filter((v) => v.impact === "critical").length,
          serious: violations.filter((v) => v.impact === "serious").length,
          moderate: violations.filter((v) => v.impact === "moderate").length,
          minor: violations.filter((v) => v.impact === "minor").length,
        },
      },
    };
  } catch (err) {
    return {
      error: err.message || "axe-core analīzes kļūda",
    };
  }
})();
