import { useState } from "react";
import { Modal, Button, Form, Table } from "react-bootstrap";
import { PARTNER_MAX_ROUNDS } from "../../constants";

interface ProjectComponent {
  id: string;
  name: string;
  gradingMode: "AUTOGRADED" | "MANUAL";
  weight: number;
}

interface ComponentDraft {
  id: string;
  name: string;
  gradingMode: "AUTOGRADED" | "MANUAL";
  weight: string;
}

interface CreateProjectModalProps {
  show: boolean;
  handleClose: () => void;
  handleSubmit: (data: {
    projectKey: string;
    repoProjectName: string;
    repoMode: "POOL" | "ON_DEMAND";
    partnerRoundNumber: number;
    components: ProjectComponent[];
  }) => Promise<void>;
  disabled?: boolean;
}

let componentCounter = 0;

export default function CreateProjectModal({
  show,
  handleClose,
  handleSubmit,
  disabled,
}: CreateProjectModalProps) {
  const [projectKey, setProjectKey] = useState("");
  const [repoProjectName, setRepoProjectName] = useState("");
  const [repoMode, setRepoMode] = useState<"POOL" | "ON_DEMAND">("POOL");
  const [partnerRoundNumber, setPartnerRoundNumber] = useState(1);
  const [repoCount, setRepoCount] = useState(200);
  const [components, setComponents] = useState<ComponentDraft[]>([
    { id: `c${++componentCounter}`, name: "", gradingMode: "AUTOGRADED", weight: "" },
  ]);
  const [error, setError] = useState<string | null>(null);

  const addComponent = () => {
    setComponents([
      ...components,
      { id: `c${++componentCounter}`, name: "", gradingMode: "MANUAL", weight: "" },
    ]);
  };

  const removeComponent = (id: string) => {
    if (components.length <= 1) return;
    setComponents(components.filter((c) => c.id !== id));
  };

  const updateComponent = (
    id: string,
    field: keyof ComponentDraft,
    value: string,
  ) => {
    setComponents(
      components.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
    );
  };

  const reset = () => {
    setProjectKey("");
    setRepoProjectName("");
    setRepoMode("POOL");
    setPartnerRoundNumber(1);
    setRepoCount(200);
    setComponents([
      { id: `c${++componentCounter}`, name: "", gradingMode: "AUTOGRADED", weight: "" },
    ]);
    setError(null);
  };

  const onSubmit = async () => {
    setError(null);
    if (!projectKey.trim()) {
      setError("Project key is required.");
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(projectKey.trim())) {
      setError("Project key must contain only letters, numbers, hyphens, and underscores.");
      return;
    }
    if (!repoProjectName.trim()) {
      setError("Repo project name is required (e.g. project-01).");
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(repoProjectName.trim())) {
      setError("Repo project name must contain only letters, numbers, hyphens, and underscores.");
      return;
    }
    const parsedWeights: number[] = [];
    for (const c of components) {
      if (!c.name.trim()) {
        setError("Every component must have a name.");
        return;
      }
      const w = c.weight === "" ? NaN : Number(c.weight);
      if (Number.isNaN(w) || w < 0) {
        setError("Weights must be non-negative numbers.");
        return;
      }
      parsedWeights.push(w);
    }
    const totalWeight = parsedWeights.reduce((sum, w) => sum + w, 0);
    if (Math.abs(totalWeight - 100) > 0.001) {
      setError(`Weights must sum to 100 (currently ${totalWeight}).`);
      return;
    }
    const hasAutograded = components.some((c) => c.gradingMode === "AUTOGRADED");
    if (!hasAutograded) {
      setError("At least one component must be autograded (for repo assignment).");
      return;
    }
    try {
      await handleSubmit({
        projectKey: projectKey.trim(),
        repoProjectName: repoProjectName.trim(),
        repoMode,
        partnerRoundNumber,
        components: components.map((c, i) => ({
          ...c,
          name: c.name.trim(),
          weight: parsedWeights[i],
          id: `${projectKey.trim()}-${c.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`,
        })),
      });
      reset();
      handleClose();
    } catch (e: any) {
      setError(e.message || "Failed to create project.");
    }
  };

  return (
    <Modal show={show} onHide={handleClose} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>Create Project</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form.Group className="mb-3">
          <Form.Label>Project Key</Form.Label>
          <Form.Control
            type="text"
            placeholder="e.g. project1"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
            isInvalid={!!error && !projectKey.trim()}
          />
          <Form.Text className="text-muted">
            Unique identifier for this project. Components will share this key.
          </Form.Text>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>Repo Project Name</Form.Label>
          <Form.Control
            type="text"
            placeholder="e.g. project-01"
            value={repoProjectName}
            onChange={(e) => setRepoProjectName(e.target.value)}
            isInvalid={!!error && !repoProjectName.trim()}
          />
          <Form.Text className="text-muted">
            Used in repo names:{" "}
            <code>{`{prefix}_.${repoProjectName || "project-1"}_.team-001`}</code>
            {repoMode === "POOL" && (
              <>
                . After creating, run:{" "}
                <code>{`npx tsx src/scripts/importProjectRepoPool.ts <courseId> ${projectKey || "project1"} ${repoProjectName || "project-01"} ${repoCount}`}</code>
              </>
            )}
          </Form.Text>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>Repo Provisioning</Form.Label>
          <div>
            <Form.Check
              inline
              type="radio"
              label="Pre-allocated pool"
              name="repoMode"
              id="repoMode-pool"
              checked={repoMode === "POOL"}
              onChange={() => setRepoMode("POOL")}
              disabled={disabled}
            />
            <Form.Check
              inline
              type="radio"
              label="Create repos on demand"
              name="repoMode"
              id="repoMode-on-demand"
              checked={repoMode === "ON_DEMAND"}
              onChange={() => setRepoMode("ON_DEMAND")}
              disabled={disabled}
            />
          </div>
          <Form.Text className="text-muted">
            {repoMode === "POOL"
              ? "Repos must be pre-created in the GitHub org and imported by script (the existing flow)."
              : "Broadway creates a fresh private GitHub repo for each group (and each staff member) when first needed - no pool import required."}
          </Form.Text>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>Partner Round</Form.Label>
          <Form.Select
            value={partnerRoundNumber}
            onChange={(e) => setPartnerRoundNumber(Number(e.target.value))}
            disabled={disabled}
          >
            {Array.from({ length: PARTNER_MAX_ROUNDS }, (_, i) => i + 1).map(
              (round) => (
                <option key={round} value={round}>
                  Round {round}
                </option>
              ),
            )}
          </Form.Select>
          <Form.Text className="text-muted">
            Students see their Round-N partner on every component of this
            project, and post-deadline runs are graded as the max across the
            group.
          </Form.Text>
        </Form.Group>

        <h5 className="mb-2">Components</h5>

        <Table bordered size="sm" className="mb-2">
          <thead>
            <tr>
              <th style={{ width: "40%" }}>Name</th>
              <th style={{ width: "25%" }}>Grading Mode</th>
              <th style={{ width: "20%" }}>Weight (%)</th>
              <th style={{ width: "15%" }}></th>
            </tr>
          </thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id}>
                <td>
                  <Form.Control
                    size="sm"
                    placeholder="e.g. Autograded"
                    value={c.name}
                    onChange={(e) => updateComponent(c.id, "name", e.target.value)}
                    disabled={disabled}
                  />
                </td>
                <td>
                  <Form.Select
                    size="sm"
                    value={c.gradingMode}
                    onChange={(e) => updateComponent(c.id, "gradingMode", e.target.value)}
                    disabled={disabled}
                  >
                    <option value="AUTOGRADED">Autograded</option>
                    <option value="MANUAL">Manual</option>
                  </Form.Select>
                </td>
                <td>
                  <Form.Control
                    size="sm"
                    type="number"
                    min={0}
                    max={100}
                    value={c.weight}
                    onChange={(e) =>
                      updateComponent(c.id, "weight", e.target.value)
                    }
                    disabled={disabled}
                  />
                </td>
                <td className="text-center">
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => removeComponent(c.id)}
                    disabled={disabled || components.length <= 1}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>

        <Button size="sm" variant="outline-primary" onClick={addComponent} disabled={disabled}>
          + Add Component
        </Button>

        {error && (
          <div className="text-danger mt-2">
            <small>{error}</small>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="secondary"
          onClick={() => {
            reset();
            handleClose();
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" onClick={onSubmit} disabled={disabled}>
          Create Project
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
