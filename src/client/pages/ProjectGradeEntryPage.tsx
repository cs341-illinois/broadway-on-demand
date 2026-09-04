import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import AppNavbar from "../components/Navbar";
import {
  Alert,
  Badge,
  Button,
  Col,
  Container,
  Form,
  Row,
  Spinner,
  Table,
} from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import { useNavigate, useParams } from "react-router-dom";
import {
  createResource,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import { Role } from "../enums";
import { LoadingScreen } from "../components/Loading";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { FullRoleEntry } from "../../types/index";

interface ProjectComponent {
  assignmentId: string;
  name: string;
  gradingMode: "AUTOGRADED" | "MANUAL";
  weight: number;
}

interface ProjectEntry {
  projectKey: string;
  components: ProjectComponent[];
}

interface StudentGradeEntry {
  score: number | null;
  comments: string | null;
}

interface StudentRow {
  netId: string;
  name: string | null;
  partnerGroupId: string | null;
  groupMembers: string[];
  repoName: string | null;
  grades: { [assignmentId: string]: StudentGradeEntry };
  combinedScore: number | null;
}

async function fetchProjects(courseId: string): Promise<ProjectEntry[]> {
  const response = await fetch(
    formulateUrl(`api/v1/projectGrades/${courseId}/projects`),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`Failed to load projects (status ${response.status}).`);
  }
  return (await response.json()) as ProjectEntry[];
}

async function fetchStudents(
  courseId: string,
  projectKey: string,
): Promise<StudentRow[]> {
  const response = await fetch(
    formulateUrl(`api/v1/projectGrades/${courseId}/${projectKey}/students`),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`Failed to load students (status ${response.status}).`);
  }
  return (await response.json()) as StudentRow[];
}

interface ProjectGradeEntryContentProps {
  projectsResource: Resource<ProjectEntry[]>;
  courseInfo: FullRoleEntry;
}

function ProjectGradeEntryContent({
  projectsResource,
  courseInfo,
}: ProjectGradeEntryContentProps): JSX.Element {
  const { courseId } = courseInfo;
  const { showAlert } = useAlert();
  const projects = projectsResource.read();

  const [selectedProjectKey, setSelectedProjectKey] = useState<string>(
    projects.length > 0 ? projects[0].projectKey : "",
  );
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [isLoadingStudents, setIsLoadingStudents] = useState<boolean>(false);
  const [netIdSearch, setNetIdSearch] = useState<string>("");

  const [editing, setEditing] = useState<{
    netId: string;
    assignmentId: string;
  } | null>(null);
  const [editScore, setEditScore] = useState<string>("");
  const [editComments, setEditComments] = useState<string>("");
  const [editJustification, setEditJustification] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  const selectedProject = useMemo(
    () => projects.find((p) => p.projectKey === selectedProjectKey) ?? null,
    [projects, selectedProjectKey],
  );

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
      setStudents(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setIsLoadingStudents(true);
      setStudents(null);
      setEditing(null);
      try {
        const data = await fetchStudents(courseId, selectedProjectKey);
        if (!cancelled) setStudents(data);
      } catch (e) {
        if (!cancelled) {
          showAlert(`Error loading students: ${(e as Error).message}`, "danger");
        }
      } finally {
        if (!cancelled) setIsLoadingStudents(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [courseId, selectedProjectKey, showAlert]);

  const refreshStudents = async () => {
    if (!selectedProjectKey) return;
    try {
      const data = await fetchStudents(courseId, selectedProjectKey);
      setStudents(data);
    } catch (e) {
      showAlert(`Error refreshing students: ${(e as Error).message}`, "danger");
    }
  };

  const startEdit = (student: StudentRow, assignmentId: string) => {
    if (submitting) return;
    const current = student.grades[assignmentId];
    setEditing({ netId: student.netId, assignmentId });
    setEditScore(current?.score != null ? String(current.score) : "");
    setEditComments(current?.comments ?? "");
    setEditJustification("");
  };

  const cancelEdit = () => {
    setEditing(null);
  };

  const submitGrade = async (student: StudentRow, assignmentId: string) => {
    const scoreStr = editScore.trim();
    const score = Number(scoreStr);
    if (scoreStr === "" || Number.isNaN(score)) {
      showAlert("Please enter a valid numeric score (0-100).", "warning");
      return;
    }
    if (score < 0 || score > 100) {
      showAlert("Score must be between 0 and 100.", "warning");
      return;
    }
    const justification = editJustification.trim();
    if (!justification) {
      showAlert("Justification is required.", "warning");
      return;
    }
    if (!student.partnerGroupId) {
      showAlert(
        "This student has no active partner group; cannot enter a group grade.",
        "warning",
      );
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(
        formulateUrl(
          `api/v1/projectGrades/${courseId}/${assignmentId}/group/${student.partnerGroupId}/grade`,
        ),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            score,
            comments: editComments || null,
            justification,
          }),
        },
      );
      if (!response.ok) {
        let message = `Failed to submit grade (status ${response.status}).`;
        try {
          const data = await response.json();
          message = data.message || message;
        } catch (e) {
          /* ignore parse error */
        }
        throw new Error(message);
      }
      showAlert(
        `Grade submitted for ${student.netId}'s group (${assignmentId}).`,
        "success",
      );
      setEditing(null);
      await refreshStudents();
    } catch (e) {
      showAlert(`Error submitting grade: ${(e as Error).message}`, "danger");
    } finally {
      setSubmitting(false);
    }
  };

  const filteredStudents = useMemo(() => {
    const q = netIdSearch.trim().toLowerCase();
    const rows = students ?? [];
    if (!q) return rows;
    return rows.filter((s) => s.netId.toLowerCase().includes(q));
  }, [students, netIdSearch]);

  const componentCount = selectedProject?.components.length ?? 0;
  const editColSpan = 4 + componentCount + 1;

  return (
    <>
      <AppNavbar
        title={courseInfo.courseName}
        breadcrumb={{
          items: [
            {
              label: "Course Home",
              href: formulateUrl(`dashboard/${courseId}`),
            },
            { label: "Project Grade Entry" },
          ],
        }}
      />
      <Container className="p-3">
        <h2>Project Grade Entry</h2>
        <p className="text-muted">
          Select a project to view all components and student scores. Manual
          components can be graded inline; autograded components are read-only.
        </p>

        <Row className="mb-3">
          <Col xs={12} md={6}>
            <Form.Group controlId="projectSelect">
              <Form.Label>Project</Form.Label>
              <Form.Select
                value={selectedProjectKey}
                onChange={(e) => setSelectedProjectKey(e.target.value)}
                disabled={projects.length === 0}
              >
                {projects.length === 0 && (
                  <option value="">No projects available</option>
                )}
                {projects.map((p) => (
                  <option key={p.projectKey} value={p.projectKey}>
                    {p.projectKey}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
          <Col xs={12} md={6}>
            <Form.Group controlId="netIdSearch">
              <Form.Label>Search by NetID</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g. jsmith2"
                value={netIdSearch}
                onChange={(e) => setNetIdSearch(e.target.value)}
              />
            </Form.Group>
          </Col>
        </Row>

        {selectedProject && (
          <div className="mb-3">
            <h5 className="mb-2">{selectedProject.projectKey} components</h5>
            <div>
              {selectedProject.components.map((comp) => (
                <span
                  key={comp.assignmentId}
                  className="me-3 mb-2 d-inline-flex align-items-center"
                >
                  <Badge
                    bg={comp.gradingMode === "MANUAL" ? "primary" : "secondary"}
                    className="me-1"
                  >
                    {comp.gradingMode === "MANUAL" ? "Manual" : "Autograded"}
                  </Badge>
                  <strong className="me-1">{comp.name}</strong>
                  <span className="text-muted">({comp.weight}%)</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {!selectedProjectKey && (
          <Alert variant="info">
            There are no projects available for this course.
          </Alert>
        )}

        {selectedProjectKey && isLoadingStudents && (
          <Spinner animation="border" role="status" />
        )}

        {selectedProjectKey &&
          !isLoadingStudents &&
          students !== null &&
          students.length === 0 && (
            <Alert variant="secondary">
              No students are available for you to grade
              {selectedProject ? ` for ${selectedProject.projectKey}` : ""}.
            </Alert>
          )}

        {selectedProjectKey &&
          !isLoadingStudents &&
          students !== null &&
          students.length > 0 && (
            <Table striped bordered hover size="sm" responsive>
              <thead>
                <tr>
                  <th>NetID</th>
                  <th>Name</th>
                  <th>Group</th>
                  <th>Repo</th>
                  {selectedProject?.components.map((comp) => (
                    <th key={comp.assignmentId}>
                      {comp.name}
                      <br />
                      <small className="text-muted">
                        {comp.gradingMode === "MANUAL" ? "Manual" : "Auto"} ·{" "}
                        {comp.weight}%
                      </small>
                    </th>
                  ))}
                  <th>Combined</th>
                </tr>
              </thead>
              <tbody>
                {filteredStudents.map((student) => {
                  const isEditingRow = editing?.netId === student.netId;
                  return (
                    <Fragment key={student.netId}>
                      <tr>
                        <td>{student.netId}</td>
                        <td>
                          {student.name ?? (
                            <span className="text-muted fst-italic">
                              unknown
                            </span>
                          )}
                        </td>
                        <td>
                          {student.groupMembers.length > 0 ? (
                            student.groupMembers.join(", ")
                          ) : (
                            <span className="text-muted fst-italic">—</span>
                          )}
                        </td>
                        <td>
                          {student.repoName ? (
                            <code>{student.repoName}</code>
                          ) : (
                            <span className="text-muted fst-italic">—</span>
                          )}
                        </td>
                        {selectedProject?.components.map((comp) => {
                          const grade = student.grades[comp.assignmentId];
                          const isEditingCell =
                            isEditingRow &&
                            editing?.assignmentId === comp.assignmentId;
                          if (comp.gradingMode === "MANUAL") {
                            return (
                              <td
                                key={comp.assignmentId}
                                className={isEditingCell ? "table-warning" : ""}
                                style={{ cursor: "pointer" }}
                                onClick={() => startEdit(student, comp.assignmentId)}
                                title="Click to enter a grade"
                              >
                                {grade?.score != null ? (
                                  grade.score
                                ) : (
                                  <span className="text-muted fst-italic">
                                    —
                                  </span>
                                )}
                              </td>
                            );
                          }
                          return (
                            <td key={comp.assignmentId} className="text-muted">
                              {grade?.score != null ? (
                                grade.score
                              ) : (
                                <span className="fst-italic">—</span>
                              )}
                            </td>
                          );
                        })}
                        <td>
                          <strong>
                            {student.combinedScore != null ? (
                              student.combinedScore
                            ) : (
                              <span className="text-muted fst-italic">—</span>
                            )}
                          </strong>
                        </td>
                      </tr>
                      {isEditingRow && editing && (
                        <tr>
                          <td colSpan={editColSpan}>
                            <div className="p-2">
                              <h6 className="mb-2">
                                Enter grade for{" "}
                                {selectedProject?.components.find(
                                  (c) => c.assignmentId === editing.assignmentId,
                                )?.name ?? editing.assignmentId}{" "}
                                — {student.netId}
                              </h6>
                              <Row>
                                <Col xs={12} md={3}>
                                  <Form.Group
                                    controlId="editScore"
                                    className="mb-2"
                                  >
                                    <Form.Label>Score (0-100)</Form.Label>
                                    <Form.Control
                                      type="number"
                                      min={0}
                                      max={100}
                                      step="0.5"
                                      value={editScore}
                                      onChange={(e) =>
                                        setEditScore(e.target.value)
                                      }
                                      disabled={submitting}
                                    />
                                  </Form.Group>
                                </Col>
                                <Col xs={12} md={9}>
                                  <Form.Group
                                    controlId="editComments"
                                    className="mb-2"
                                  >
                                    <Form.Label>Comments</Form.Label>
                                    <Form.Control
                                      as="textarea"
                                      rows={1}
                                      value={editComments}
                                      onChange={(e) =>
                                        setEditComments(e.target.value)
                                      }
                                      disabled={submitting}
                                    />
                                  </Form.Group>
                                </Col>
                              </Row>
                              <Form.Group
                                controlId="editJustification"
                                className="mb-2"
                              >
                                <Form.Label>Justification (required)</Form.Label>
                                <Form.Control
                                  as="textarea"
                                  rows={2}
                                  placeholder="Reason for this grade change"
                                  value={editJustification}
                                  onChange={(e) =>
                                    setEditJustification(e.target.value)
                                  }
                                  disabled={submitting}
                                />
                              </Form.Group>
                              <div>
                                <Button
                                  onClick={() =>
                                    submitGrade(student, editing.assignmentId)
                                  }
                                  disabled={submitting}
                                >
                                  {submitting ? (
                                    <>
                                      <Spinner
                                        as="span"
                                        size="sm"
                                        animation="border"
                                        className="me-2"
                                      />
                                      Submitting...
                                    </>
                                  ) : (
                                    "Submit grade"
                                  )}
                                </Button>{" "}
                                <Button
                                  variant="secondary"
                                  onClick={cancelEdit}
                                  disabled={submitting}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}

        {selectedProjectKey &&
          !isLoadingStudents &&
          students !== null &&
          students.length > 0 &&
          filteredStudents.length === 0 && (
            <Alert variant="info">
              No students match &ldquo;{netIdSearch}&rdquo;.
            </Alert>
          )}
      </Container>
    </>
  );
}

export default function ProjectGradeEntryPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const [courseInfo, setCourseInfo] = useState<FullRoleEntry | null>(null);

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [] as string[];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  const isStaffOrAdmin = useMemo(
    () =>
      courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF),
    [courseRoles],
  );

  useEffect(() => {
    if (!user) return;
    if (!courseId || !isStaffOrAdmin) {
      showAlert(
        "You do not have permission to view this page or the course ID is invalid.",
        "danger",
      );
      navigate(formulateUrl("dashboard"));
      return;
    }
    const info = getCourseInfo(user, courseId)!;
    setCourseInfo(info);
    setCourseInfoSessionStorage(info);
    document.title = `Project Grade Entry | ${info?.courseName || "Course"}`;
  }, [courseId, user, isStaffOrAdmin, navigate, showAlert]);

  const projectsResource = useMemo<Resource<ProjectEntry[]>>(() => {
    if (!user || !courseId || !isStaffOrAdmin) {
      return createResource<ProjectEntry[]>(() =>
        Promise.reject(
          new Error(
            "Access denied or prerequisites not met for loading projects.",
          ),
        ),
      );
    }
    return createResource<ProjectEntry[]>(() => fetchProjects(courseId));
  }, [courseId, isStaffOrAdmin, user]);

  if (!user || !courseInfo) {
    return <LoadingScreen message="Authenticating..." />;
  }
  if (!isStaffOrAdmin) {
    return <LoadingScreen message="Checking permissions..." />;
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <ProjectGradeEntryContent
            projectsResource={projectsResource}
            courseInfo={courseInfo}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
