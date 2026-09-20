import { useEffect, useMemo, useState, Suspense } from "react";
import {
  Container,
  Card,
  Button,
  Row,
  Col,
  Table,
  Badge,
  Spinner,
  Form,
  Alert,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  createResource,
  downloadText,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import ConfirmationModal from "../components/ConfirmationModal";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";
import { CourseInformationResponse } from "../../types/assignment";
import { Role } from "../enums";

interface ProjectEntry {
  projectKey: string;
}

interface FreeRepo {
  repoName: string;
  sortOrder: number;
}

interface GarbageRepo {
  repoName: string;
  assignedNetIds: string[];
  reason: string;
  reclaimable: boolean;
}

interface ConflictMember {
  netId: string;
  repoName: string | null;
}

interface Conflict {
  partnerGroupId: string;
  members: ConflictMember[];
}

interface Gap {
  partnerGroupId: string;
  members: { netId: string }[];
}

interface AssignmentRow {
  netId: string;
  repoName: string;
  partnerGroupId: string | null;
  assignedAt: string;
  githubAccessConfirmed: boolean;
}

interface ProjectReposStatus {
  freeRepos: FreeRepo[];
  garbageRepos: GarbageRepo[];
  conflicts: Conflict[];
  gaps: Gap[];
  assignments: AssignmentRow[];
}

interface ProjectReposPageData {
  courseDetails: CourseInformationResponse;
  projects: ProjectEntry[];
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(formulateUrl(url), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

async function getProjectReposPageData(
  courseId: string,
): Promise<ProjectReposPageData> {
  const [courseDetails, projects] = await Promise.all([
    fetchJson<CourseInformationResponse>(`api/v1/courses/${courseId}`),
    fetchJson<ProjectEntry[]>(`api/v1/projectRepos/${courseId}/projects`),
  ]);
  return { courseDetails, projects };
}

interface ContentProps {
  resource: Resource<ProjectReposPageData>;
  courseId: string;
  isAdmin: boolean;
  showAlert: ReturnType<typeof useAlert>["showAlert"];
}

function ProjectReposContent({
  resource,
  courseId,
  isAdmin,
  showAlert,
}: ContentProps) {
  const { courseDetails, projects } = resource.read();
  const [selectedProjectKey, setSelectedProjectKey] = useState<string>(
    projects.length > 0 ? projects[0].projectKey : "",
  );
  const [status, setStatus] = useState<ProjectReposStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [releaseTarget, setReleaseTarget] = useState<string | null>(null);
  const [isReleasing, setIsReleasing] = useState(false);
  const [reclaimTarget, setReclaimTarget] = useState<string | null>(null);
  const [isReclaiming, setIsReclaiming] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const [showReconcileConfirm, setShowReconcileConfirm] = useState(false);
  const [isSyncingAccess, setIsSyncingAccess] = useState(false);
  const [assignNetIdsInput, setAssignNetIdsInput] = useState("");
  const [assignRepoNameInput, setAssignRepoNameInput] = useState("");
  const [isAssigning, setIsAssigning] = useState(false);
  const [assignConflictBlockers, setAssignConflictBlockers] = useState<
    string[]
  >([]);

  useEffect(() => {
    if (
      projects.length > 0 &&
      !projects.some((p) => p.projectKey === selectedProjectKey)
    ) {
      setSelectedProjectKey(projects[0].projectKey);
    }
  }, [projects, selectedProjectKey]);

  useEffect(() => {
    if (!selectedProjectKey) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setStatusLoading(true);
      setStatusError(null);
      try {
        const data = await fetchJson<ProjectReposStatus>(
          `api/v1/projectRepos/${courseId}/${selectedProjectKey}/status`,
        );
        if (!cancelled) setStatus(data);
      } catch (error) {
        if (!cancelled) setStatusError((error as Error).message);
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [courseId, selectedProjectKey]);

  const refresh = () => {
    if (!selectedProjectKey) return;
    setStatusLoading(true);
    fetchJson<ProjectReposStatus>(
      `api/v1/projectRepos/${courseId}/${selectedProjectKey}/status`,
    )
      .then((data) => {
        setStatus(data);
        setStatusError(null);
      })
      .catch((error) => setStatusError(error.message))
      .finally(() => setStatusLoading(false));
  };

  const handleRelease = async () => {
    if (!releaseTarget || !selectedProjectKey) return;
    setIsReleasing(true);
    try {
      const result = await fetchJson<{ released: number; warning: string }>(
        `api/v1/projectRepos/${courseId}/${selectedProjectKey}/release`,
        { method: "POST", body: JSON.stringify({ repoName: releaseTarget }) },
      );
      showAlert(
        `Released ${result.released} assignment(s) for ${releaseTarget}. ${result.warning}`,
        "warning",
        8000,
      );
      setReleaseTarget(null);
      refresh();
    } catch (error) {
      showAlert(
        (error as Error).message || "Failed to release repo.",
        "danger",
      );
    } finally {
      setIsReleasing(false);
    }
  };

  const handleReclaim = async () => {
    if (!reclaimTarget || !selectedProjectKey) return;
    setIsReclaiming(true);
    try {
      const result = await fetchJson<{ released: number; warning: string }>(
        `api/v1/projectRepos/${courseId}/${selectedProjectKey}/reclaim`,
        { method: "POST", body: JSON.stringify({ repoName: reclaimTarget }) },
      );
      showAlert(
        `Reclaimed ${result.released} assignment(s) for ${reclaimTarget}. ${result.warning}`,
        "warning",
        8000,
      );
      setReclaimTarget(null);
      refresh();
    } catch (error) {
      showAlert(
        (error as Error).message || "Failed to reclaim repo.",
        "danger",
      );
    } finally {
      setIsReclaiming(false);
    }
  };

  const handleExport = async () => {
    if (!selectedProjectKey) return;
    setIsExporting(true);
    try {
      const response = await fetch(
        formulateUrl(
          `api/v1/projectRepos/${courseId}/${selectedProjectKey}/export`,
        ),
        { credentials: "include" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || `Export failed: ${response.status}`);
      }
      const text = await response.text();
      downloadText(`project_${selectedProjectKey}_export.csv`, text);
    } catch (error) {
      showAlert((error as Error).message || "Export failed.", "danger");
    } finally {
      setIsExporting(false);
    }
  };

  const handleReconcile = async () => {
    if (!selectedProjectKey) return;
    setIsReconciling(true);
    try {
      const result = await fetchJson<{
        claimed: number;
        extended: number;
        conflicts: number;
        gaps: number;
      }>(`api/v1/projectRepos/${courseId}/${selectedProjectKey}/reconcile`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const parts: string[] = [];
      if (result.claimed) parts.push(`${result.claimed} new claim(s)`);
      if (result.extended) parts.push(`${result.extended} extension(s)`);
      if (result.conflicts) parts.push(`${result.conflicts} conflict(s)`);
      if (result.gaps) parts.push(`${result.gaps} gap(s)`);
      showAlert(
        parts.length > 0
          ? `Reconciliation complete: ${parts.join(", ")}.`
          : "Reconciliation complete: nothing to do.",
        "success",
      );
      refresh();
    } catch (error) {
      showAlert((error as Error).message || "Reconciliation failed.", "danger");
    } finally {
      setIsReconciling(false);
    }
  };

  const handleAssign = async (opts?: {
    displaceBlockers?: boolean;
    includeBlockers?: string[];
  }) => {
    if (!selectedProjectKey) return;
    const netIds = assignNetIdsInput
      .split(/[\s,]+/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const allNetIds = [
      ...new Set([...netIds, ...(opts?.includeBlockers ?? [])]),
    ];
    const repoName = assignRepoNameInput.trim();
    if (allNetIds.length === 0 || !repoName) {
      showAlert("Enter at least one netId and a target repo name.", "warning");
      return;
    }
    if (!opts?.displaceBlockers) {
      const finalNetIdSet = new Set(allNetIds);
      const blockers = (status?.assignments ?? [])
        .filter((a) => a.repoName === repoName)
        .map((a) => a.netId)
        .filter((n) => !finalNetIdSet.has(n));
      if (blockers.length > 0) {
        setAssignConflictBlockers(blockers);
        showAlert(
          `${repoName} is actively assigned to ${blockers.join(", ")}. Choose how to resolve it below.`,
          "warning",
        );
        return;
      }
    }
    setAssignConflictBlockers([]);
    setIsAssigning(true);
    try {
      const result = await fetchJson<{
        results: {
          netId: string;
          repoName: string;
          previousRepoName: string | null;
          githubAccessGranted: boolean;
          githubAccessError: string | null;
        }[];
        releasedBlockers: string[];
        accessWarnings: string[];
      }>(`api/v1/projectRepos/${courseId}/${selectedProjectKey}/assign`, {
        method: "POST",
        body: JSON.stringify({
          netIds: allNetIds,
          repoName,
          displaceBlockers: !!opts?.displaceBlockers,
        }),
      });
      const lines = result.results.map((r) => {
        const moved =
          r.previousRepoName && r.previousRepoName !== r.repoName
            ? ` (was ${r.previousRepoName})`
            : "";
        const access = r.githubAccessGranted
          ? "access granted"
          : `access NOT granted: ${r.githubAccessError}`;
        return `${r.netId} → ${r.repoName}${moved} — ${access}`;
      });
      if (result.releasedBlockers.length > 0) {
        lines.push(
          `released previous holder(s): ${result.releasedBlockers.join(", ")}`,
        );
      }
      for (const w of result.accessWarnings) lines.push(`⚠ ${w}`);
      const anyAccessFailed =
        result.results.some((r) => !r.githubAccessGranted) ||
        result.accessWarnings.length > 0;
      showAlert(
        lines.join("; "),
        anyAccessFailed ? "warning" : "success",
        10000,
      );
      setAssignNetIdsInput("");
      setAssignRepoNameInput("");
      refresh();
    } catch (error) {
      showAlert(
        (error as Error).message || "Manual assignment failed.",
        "danger",
      );
    } finally {
      setIsAssigning(false);
    }
  };

  const handleSyncAccess = async () => {
    if (!selectedProjectKey) return;
    setIsSyncingAccess(true);
    try {
      const result = await fetchJson<{
        confirmed: number;
        added: number;
        noMapping: number;
        failed: number;
        total: number;
      }>(`api/v1/projectRepos/${courseId}/${selectedProjectKey}/syncAccess`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const parts: string[] = [];
      if (result.added) parts.push(`${result.added} newly added`);
      if (result.confirmed) parts.push(`${result.confirmed} already confirmed`);
      if (result.noMapping) parts.push(`${result.noMapping} missing username`);
      if (result.failed) parts.push(`${result.failed} failed`);
      showAlert(
        `GitHub access sync: ${parts.join(", ")}.`,
        result.failed > 0 ? "warning" : "success",
        8000,
      );
      refresh();
    } catch (error) {
      showAlert((error as Error).message || "Access sync failed.", "danger");
    } finally {
      setIsSyncingAccess(false);
    }
  };

  const breadcrumb = {
    items: [
      { label: "Course Home", href: formulateUrl(`dashboard/${courseId}`) },
      { label: "Project Repos" },
    ],
  };

  return (
    <>
      <AppNavbar title={courseDetails.name} breadcrumb={breadcrumb} />
      <Container className="p-3 mb-5 flex-grow-1">
        <Row className="mb-3 align-items-center">
          <Col>
            <h1>Project Repos</h1>
            <p className="text-muted mb-0">
              Visibility into shared project repo assignments, free pool
              capacity, and reclaimable ("garbage") repos.
            </p>
          </Col>
          {isAdmin && selectedProjectKey && (
            <Col xs="auto">
              <Button
                variant="primary"
                onClick={() => setShowReconcileConfirm(true)}
                disabled={isReconciling || statusLoading}
                className="me-2"
              >
                {isReconciling ? (
                  <Spinner
                    as="span"
                    size="sm"
                    animation="border"
                    className="me-1"
                  />
                ) : null}
                Reconcile
              </Button>
              <Button
                variant="success"
                onClick={handleSyncAccess}
                disabled={isSyncingAccess || statusLoading}
                className="me-2"
              >
                {isSyncingAccess ? (
                  <Spinner
                    as="span"
                    size="sm"
                    animation="border"
                    className="me-1"
                  />
                ) : null}
                Sync GitHub Access
              </Button>
              <Button
                variant="outline-secondary"
                onClick={handleExport}
                disabled={isExporting || statusLoading}
              >
                {isExporting ? (
                  <Spinner
                    as="span"
                    size="sm"
                    animation="border"
                    className="me-1"
                  />
                ) : null}
                Export CSV
              </Button>
            </Col>
          )}
        </Row>

        <Alert variant="info" className="mb-3">
          Click <strong>Sync GitHub Access</strong> to add each student as a
          collaborator on their assigned repo using their mined GitHub username.
        </Alert>

        {projects.length === 0 ? (
          <Card>
            <Card.Body className="text-muted">
              No PROJECT assignments exist in this course yet.
            </Card.Body>
          </Card>
        ) : (
          <>
            <Form.Group className="mb-3" style={{ maxWidth: 360 }}>
              <Form.Label>Project</Form.Label>
              <Form.Select
                value={selectedProjectKey}
                onChange={(e) => setSelectedProjectKey(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.projectKey} value={p.projectKey}>
                    {p.projectKey}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>

            {statusLoading && !status && (
              <div className="text-muted">
                <Spinner
                  as="span"
                  size="sm"
                  animation="border"
                  className="me-2"
                />
                Loading status...
              </div>
            )}
            {statusError && (
              <Alert variant="danger">
                Failed to load status: {statusError}
              </Alert>
            )}

            {status && (
              <>
                {isAdmin && (
                  <Row className="mb-4">
                    <Col>
                      <Card border="primary">
                        <Card.Header as="h5">Manually Assign Repo</Card.Header>
                        <Card.Body>
                          <p className="text-muted">
                            Assigns the given netId(s) to a specific repo,
                            bypassing the free-pool claim logic. Useful for
                            giving a student back a repo they've already used
                            (e.g. after a partner change), or fixing a gap by
                            hand. If a netId already has a different active
                            assignment, it is released first. If the target repo
                            is held by someone else, you'll be offered to
                            release them or include them. GitHub access is
                            granted immediately for just these netIds.
                          </p>
                          <Row className="g-2 align-items-end">
                            <Col md={5}>
                              <Form.Label>NetId(s)</Form.Label>
                              <Form.Control
                                type="text"
                                placeholder="e.g. annacg4"
                                value={assignNetIdsInput}
                                onChange={(e) =>
                                  setAssignNetIdsInput(e.target.value)
                                }
                              />
                              <Form.Text className="text-muted">
                                Comma or space separated for multiple.
                              </Form.Text>
                            </Col>
                            <Col md={4}>
                              <Form.Label>Target Repo</Form.Label>
                              <Form.Control
                                type="text"
                                placeholder="e.g. fa26_cs341_.project-1_.team-104"
                                value={assignRepoNameInput}
                                onChange={(e) =>
                                  setAssignRepoNameInput(e.target.value)
                                }
                              />
                            </Col>
                            <Col md={3}>
                              <Button
                                variant="primary"
                                onClick={() => handleAssign()}
                                disabled={isAssigning}
                                className="w-100"
                              >
                                {isAssigning ? (
                                  <Spinner
                                    as="span"
                                    size="sm"
                                    animation="border"
                                    className="me-1"
                                  />
                                ) : null}
                                Assign
                              </Button>
                            </Col>
                          </Row>
                          {assignConflictBlockers.length > 0 && (
                            <Alert variant="warning" className="mt-3 mb-0">
                              <div className="mb-2">
                                <strong>{assignRepoNameInput.trim()}</strong> is
                                actively assigned to{" "}
                                <strong>
                                  {assignConflictBlockers.join(", ")}
                                </strong>
                                . To assign{" "}
                                {assignNetIdsInput.trim() ||
                                  "the entered netId(s)"}
                                , either release the current holder(s) or
                                include them in this assignment.
                              </div>
                              <div className="d-flex gap-2">
                                <Button
                                  size="sm"
                                  variant="warning"
                                  disabled={isAssigning}
                                  onClick={() =>
                                    handleAssign({ displaceBlockers: true })
                                  }
                                >
                                  Release them &amp; assign
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline-primary"
                                  disabled={isAssigning}
                                  onClick={() =>
                                    handleAssign({
                                      includeBlockers: assignConflictBlockers,
                                    })
                                  }
                                >
                                  Include them &amp; assign
                                </Button>
                                <Button
                                  size="sm"
                                  variant="link"
                                  disabled={isAssigning}
                                  onClick={() => setAssignConflictBlockers([])}
                                >
                                  Dismiss
                                </Button>
                              </div>
                            </Alert>
                          )}
                        </Card.Body>
                      </Card>
                    </Col>
                  </Row>
                )}
                <Row className="mb-4">
                  <Col>
                    <Card>
                      <Card.Header as="h5">
                        Free Repos{" "}
                        <Badge bg="success">{status.freeRepos.length}</Badge>
                      </Card.Header>
                      <Card.Body>
                        {status.freeRepos.length === 0 ? (
                          <p className="text-muted mb-0">
                            No free repos in the pool. Pool may be exhausted.
                          </p>
                        ) : (
                          <Table
                            responsive
                            striped
                            bordered
                            hover
                            size="sm"
                            className="mb-0"
                          >
                            <thead>
                              <tr>
                                <th>Sort Order</th>
                                <th>Repo Name</th>
                              </tr>
                            </thead>
                            <tbody>
                              {status.freeRepos.map((r) => (
                                <tr key={r.repoName}>
                                  <td>{r.sortOrder}</td>
                                  <td>{r.repoName}</td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        )}
                      </Card.Body>
                    </Card>
                  </Col>
                </Row>

                <Row className="mb-4">
                  <Col>
                    <Card border="warning">
                      <Card.Header as="h5">
                        Garbage Repos (reclaimable){" "}
                        <Badge bg="warning" text="dark">
                          {status.garbageRepos.length}
                        </Badge>
                      </Card.Header>
                      <Card.Body>
                        {status.garbageRepos.length === 0 ? (
                          <p className="text-muted mb-0">No garbage repos.</p>
                        ) : (
                          <Table
                            responsive
                            striped
                            bordered
                            hover
                            size="sm"
                            className="mb-0"
                          >
                            <thead>
                              <tr>
                                <th>Repo Name</th>
                                <th>Assigned NetIds</th>
                                <th>Reason</th>
                                {isAdmin && <th>Actions</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {status.garbageRepos.map((r) => (
                                <tr key={r.repoName}>
                                  <td>{r.repoName}</td>
                                  <td>{r.assignedNetIds.join(", ")}</td>
                                  <td>
                                    <small className="text-muted">
                                      {r.reason}
                                    </small>
                                  </td>
                                  {isAdmin && (
                                    <td>
                                      {r.reclaimable ? (
                                        <Button
                                          variant="outline-success"
                                          size="sm"
                                          onClick={() =>
                                            setReclaimTarget(r.repoName)
                                          }
                                        >
                                          Reclaim
                                        </Button>
                                      ) : (
                                        <Button
                                          variant="outline-danger"
                                          size="sm"
                                          onClick={() =>
                                            setReleaseTarget(r.repoName)
                                          }
                                        >
                                          Release
                                        </Button>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        )}
                      </Card.Body>
                    </Card>
                  </Col>
                </Row>

                <Row className="mb-4">
                  <Col>
                    <Card border="danger">
                      <Card.Header as="h5">
                        Conflicts{" "}
                        <Badge bg="danger">{status.conflicts.length}</Badge>
                      </Card.Header>
                      <Card.Body>
                        {status.conflicts.length === 0 ? (
                          <p className="text-muted mb-0">No conflicts.</p>
                        ) : (
                          status.conflicts.map((c) => (
                            <div key={c.partnerGroupId} className="mb-2">
                              <strong>Group {c.partnerGroupId}</strong>
                              <div>
                                {c.members.map((m) => (
                                  <Badge
                                    bg={m.repoName ? "secondary" : "light"}
                                    text={m.repoName ? undefined : "dark"}
                                    className="me-1"
                                    key={m.netId}
                                  >
                                    {m.netId}
                                    {m.repoName
                                      ? ` → ${m.repoName}`
                                      : " → (none)"}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          ))
                        )}
                      </Card.Body>
                    </Card>
                  </Col>
                </Row>

                <Row className="mb-4">
                  <Col>
                    <Card border="info">
                      <Card.Header as="h5">
                        Gaps (unassigned members){" "}
                        <Badge bg="info">{status.gaps.length}</Badge>
                      </Card.Header>
                      <Card.Body>
                        {status.gaps.length === 0 ? (
                          <p className="text-muted mb-0">No gaps.</p>
                        ) : (
                          <Table
                            responsive
                            striped
                            bordered
                            hover
                            size="sm"
                            className="mb-0"
                          >
                            <thead>
                              <tr>
                                <th>Group</th>
                                <th>Unassigned NetIds</th>
                                {isAdmin && <th>Actions</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {status.gaps.map((g) => (
                                <tr key={g.partnerGroupId}>
                                  <td>{g.partnerGroupId}</td>
                                  <td>
                                    {g.members.map((m) => m.netId).join(", ")}
                                  </td>
                                  {isAdmin && (
                                    <td>
                                      <Button
                                        variant="outline-primary"
                                        size="sm"
                                        onClick={() =>
                                          setAssignNetIdsInput(
                                            g.members
                                              .map((m) => m.netId)
                                              .join(", "),
                                          )
                                        }
                                      >
                                        Fill into Assign form
                                      </Button>
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        )}
                      </Card.Body>
                    </Card>
                  </Col>
                </Row>

                <Row className="mb-4">
                  <Col>
                    <Card>
                      <Card.Header as="h5">
                        Current Assignments{" "}
                        <Badge bg="primary">{status.assignments.length}</Badge>
                      </Card.Header>
                      <Card.Body>
                        {status.assignments.length === 0 ? (
                          <p className="text-muted mb-0">
                            No active assignments.
                          </p>
                        ) : (
                          <Table
                            responsive
                            striped
                            bordered
                            hover
                            size="sm"
                            className="mb-0"
                          >
                            <thead>
                              <tr>
                                <th>NetId</th>
                                <th>Repo</th>
                                <th>Source Group</th>
                                <th>Assigned At</th>
                                <th>Access</th>
                              </tr>
                            </thead>
                            <tbody>
                              {status.assignments.map((a) => (
                                <tr key={a.netId + a.repoName}>
                                  <td>{a.netId}</td>
                                  <td>{a.repoName}</td>
                                  <td>{a.partnerGroupId ?? "—"}</td>
                                  <td>
                                    {new Date(a.assignedAt).toLocaleString()}
                                  </td>
                                  <td>
                                    {a.githubAccessConfirmed ? (
                                      <Badge bg="success">
                                        Access confirmed
                                      </Badge>
                                    ) : (
                                      <Badge bg="warning" text="dark">
                                        Access may be pending
                                      </Badge>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        )}
                      </Card.Body>
                    </Card>
                  </Col>
                </Row>
              </>
            )}
          </>
        )}

        <ConfirmationModal
          show={releaseTarget !== null}
          title={`Release ${releaseTarget ?? ""}`}
          message={
            <>
              This soft-deletes all active assignments for this repo, preserving
              the audit trail. Broadway cannot verify or wipe the repo's actual
              GitHub content — remove collaborators from GitHub manually if
              needed.
            </>
          }
          confirmText="Release"
          isProcessing={isReleasing}
          onConfirm={handleRelease}
          onCancel={() => setReleaseTarget(null)}
        />

        <ConfirmationModal
          show={reclaimTarget !== null}
          title={`Reclaim ${reclaimTarget ?? ""}`}
          message={
            <>
              This permanently deletes the released assignment rows for this
              repo and returns it to the free pool. The audit trail is
              preserved. Broadway cannot verify or wipe the repo's actual GitHub
              content — remove collaborators from GitHub manually if needed.
            </>
          }
          confirmText="Reclaim"
          isProcessing={isReclaiming}
          onConfirm={handleReclaim}
          onCancel={() => setReclaimTarget(null)}
        />

        <ConfirmationModal
          show={showReconcileConfirm}
          title={`Reconcile ${selectedProjectKey}`}
          message={
            <>
              This assigns repos to any groups that don't have one yet, using
              the next available free repos from the pool. Existing assignments
              are not changed. Repos that were previously assigned and released
              will not be reused.
            </>
          }
          confirmText="Reconcile"
          isProcessing={isReconciling}
          onConfirm={handleReconcile}
          onCancel={() => setShowReconcileConfirm(false)}
        />
      </Container>
    </>
  );
}

export default function ProjectReposPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);
  const isStaffOrAdmin = useMemo(
    () => courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF),
    [courseRoles],
  );
  const isAdmin = useMemo(
    () => courseRoles.includes(Role.ADMIN),
    [courseRoles],
  );

  useEffect(() => {
    if (!user) return;
    if (!courseId || courseRoles.length === 0) {
      showAlert("You do not have permission to view this page.", "danger");
      navigate(formulateUrl("dashboard"));
      return;
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Project Repos | ${courseInfo.courseName}`;
  }, [courseId, user, courseRoles, navigate, showAlert]);

  const resource = useMemo<Resource<ProjectReposPageData>>(() => {
    if (!courseId || !isStaffOrAdmin) {
      return createResource<ProjectReposPageData>(() =>
        Promise.reject(new Error("Access denied.")),
      );
    }
    return createResource<ProjectReposPageData>(() =>
      getProjectReposPageData(courseId),
    );
  }, [courseId, isStaffOrAdmin]);

  if (!user) {
    return <LoadingScreen message="Loading user data..." />;
  }
  if (!courseId || courseRoles.length === 0) {
    return <LoadingScreen message="Checking permissions..." />;
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <ProjectReposContent
            resource={resource}
            courseId={courseId}
            isAdmin={isAdmin}
            showAlert={showAlert}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
