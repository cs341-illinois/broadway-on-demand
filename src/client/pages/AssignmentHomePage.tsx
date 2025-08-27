import { useState, useEffect, Suspense, useMemo } from "react";
import {
  Button,
  Card,
  Col,
  Container,
  Modal, // 👈 ADDED: Import Modal
  OverlayTrigger,
  Row,
  Table,
  Tooltip,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";
import moment from "moment-timezone";
import pluralize from "pluralize";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  createResource,
  dateTimeFormatString,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  getTimeZoneName,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import GradeAssignmentModal from "../components/GradeAssignmentModal";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";

import {
  AssignmentInformationResponse,
  assignmentResponseBody,
  JobStatusColors, // Zod schema for parsing
  JobStatusLabels,
} from "../../types/assignment";
import { JobStatus, Role } from "../enums";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { jobResponse, subscribePayload } from "../../types/websocket";

const getFeedbackFileName = (
  date: Date,
  jobId: string,
  courseTimezone: string,
): string => {
  const timezoneDate = moment(date).tz(courseTimezone);
  const formatted = timezoneDate.format("MM_DD_YY_HH_mm_ss");
  return `feedback_${formatted}_${jobId}.md`;
};

async function getAssignmentData(
  courseId: string,
  assignmentId: string,
): Promise<AssignmentInformationResponse> {
  if (!courseId || !assignmentId) {
    throw new Error("Course ID or Assignment ID is missing.");
  }
  const response = await fetch(
    formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}`),
  );
  if (!response.ok) {
    let errorMessage = `Failed to fetch assignment data. Status: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorData.detail || errorMessage;
    } catch (e) {
      /* Do nothing */
    }
    throw new Error(errorMessage);
  }
  const jsonData = await response.json();
  const result = await assignmentResponseBody.safeParseAsync(jsonData);

  if (!result.success) {
    console.error("Zod parsing error:", result.error.flatten());
    throw new Error("Failed to parse assignment data: " + result.error.message);
  }
  return result.data;
}

interface AssignmentContentProps {
  assignmentResource: Resource<AssignmentInformationResponse>;
  courseId: string;
  assignmentId: string;
  isStaff: boolean;
  // 👇 MODIFIED: Prop name and type changed to handle click events
  onGradeClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  navigate: ReturnType<typeof useNavigate>;
}

function AssignmentContent({
  assignmentResource,
  courseId,
  assignmentId,
  isStaff,
  onGradeClick, // 👈 MODIFIED: Prop name changed
  navigate,
}: AssignmentContentProps) {
  const [assignmentData, setAssignmentData] =
    useState<AssignmentInformationResponse>(assignmentResource.read());
  const socketUrl = formulateUrl(`api/v1/ws/job/${courseId}`).replace(
    "http",
    "ws",
  );
  const { showAlert } = useAlert();
  const { sendJsonMessage, lastJsonMessage, readyState } = useWebSocket(
    socketUrl,
    {
      share: true,
      shouldReconnect: (_closeEvent) => true,
      onOpen: () => console.log("WebSocket connection established"),
      onError: (event) => {
        console.error("WebSocket error:", event);
        showAlert("Failed to connect to server. Please refresh.", "warning");
      },
      onClose: (_event) => console.log("WebSocket connection closed."),
    },
  );
  useEffect(() => {
    const currentData = assignmentResource.read();
    setAssignmentData(currentData);
    document.title = `${currentData.assignmentName} | ${currentData.courseName}`;
  }, [assignmentResource]); // currentData will be stable if assignmentResource instance is stable. Read directly.

  useMemo(() => {
    if (readyState === ReadyState.OPEN && assignmentData?.studentRuns) {
      const jobIdsToSubscribe = assignmentData.studentRuns.map((run) => run.id);
      if (jobIdsToSubscribe.length > 0) {
        const payload = { jobs: jobIdsToSubscribe };
        const validationResult = subscribePayload.safeParse(payload);
        if (validationResult.success) {
          sendJsonMessage(validationResult.data);
        } else {
          console.error(
            "WebSocket subscription payload validation error:",
            validationResult.error.flatten(),
          );
          showAlert(
            "Could not subscribe to job updates due to invalid data.",
            "warning",
          );
        }
      }
    }
  }, [readyState, assignmentData, sendJsonMessage, showAlert]);

  useEffect(() => {
    if (lastJsonMessage) {
      if (Object.keys(lastJsonMessage).length === 0) {
        return;
      }
      const result = jobResponse.safeParse(lastJsonMessage);
      if (result.success) {
        const { id: updatedJobId, status: newStatus } = result.data;
        setAssignmentData((prevValue) => ({
          ...prevValue,
          studentRuns: prevValue.studentRuns.map((x) => {
            if (x.id === updatedJobId) {
              return { ...x, status: newStatus };
            }
            return x;
          }),
        }));
      } else {
        console.error(
          "Failed to parse job update from WebSocket:",
          result.error.flatten(),
          "Original message:",
          lastJsonMessage,
        );
      }
    }
  }, [lastJsonMessage]);

  const tooltip = assignmentData.gradingEligibility.eligible ? (
    <Tooltip id="grading-run-explain">
      Run source: {assignmentData.gradingEligibility.source.type}
    </Tooltip>
  ) : null;

  return (
    <>
      <AppNavbar
        title={assignmentData.courseName}
        breadcrumb={{
          items: [
            {
              label: "Course Home",
              href: formulateUrl(`dashboard/${courseId}`),
            },
            { label: assignmentData.assignmentName },
          ],
        }}
      />
      <Container className="p-2 flex-grow-1">
        <h2>{assignmentData.assignmentName}</h2>
        <p>
          Due {moment(assignmentData.dueAt).fromNow()} (
          {moment(assignmentData.dueAt).format(dateTimeFormatString)}).
        </p>
        <p className="text-muted">
          All timestamps shown in your local timezone (
          {getTimeZoneName()}).
        </p>
        <Row className="mb-3">
          {isStaff && (
            <Col xs={12} md="auto">
              <Button
                onClick={() =>
                  navigate(
                    formulateUrl(
                      `dashboard/${courseId}/assignment/${assignmentId}/manage`,
                    ),
                  )
                }
              >
                Manage Assignment
              </Button>
            </Col>
          )}
        </Row>
        <Row className="pt-3">
          <Col md={8} xs={12}>
            <h3>Your Runs</h3>
            {assignmentData.studentRuns.length === 0 && (
              <p className="text-muted">No runs found.</p>
            )}
            {assignmentData.studentRuns.length > 0 && (
              <Table hover responsive>
                <thead>
                  <tr>
                    <th>Scheduled At</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assignmentData.studentRuns.map((run) => (
                    <tr key={run.id}>
                      <td>
                        {moment(run.scheduledAt).format(dateTimeFormatString)}
                      </td>
                      <td className={`text-${JobStatusColors[run.status]}`}>
                        {JobStatusLabels[run.status]}
                        {run.status === JobStatus.PENDING && (
                          <div
                            className="spinner-grow spinner-grow-sm ms-2"
                            role="status"
                          >
                            <span className="visually-hidden">
                              Scheduled...
                            </span>
                          </div>
                        )}
                        {run.status === JobStatus.RUNNING && (
                          <div
                            className="spinner-border spinner-border-sm ms-2"
                            role="status"
                          >
                            <span className="visually-hidden">Grading...</span>
                          </div>
                        )}
                      </td>
                      <td>
                        {run.status === "COMPLETED" ? (
                          <Button
                            variant="outline-primary"
                            size="sm"
                            onClick={() => {
                              window.open(
                                `${assignmentData.feedbackBaseUrl}/${getFeedbackFileName(
                                  new Date(run.dueAt),
                                  run.id,
                                  assignmentData.courseTimezone,
                                )}`,
                                "_blank",
                                "noopener,noreferrer",
                              );
                            }}
                          >
                            View Feedback
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Col>
          <Col md={4} xs={12}>
            <Card>
              <Card.Header as="h4">Grade Assignment</Card.Header>
              <Card.Body>
                {!assignmentData.gradingEligibility.eligible && (
                  <p className="text-muted">
                    You have no more grading runs remaining.
                  </p>
                )}
                {assignmentData.gradingEligibility.eligible && (
                  <>
                    <OverlayTrigger placement="top" overlay={tooltip || <></>}>
                      <span>
                        <p>
                          You have{" "}
                          <b>
                            {pluralize(
                              "run",
                              assignmentData.gradingEligibility
                                .numRunsRemaining === "infinity"
                                ? Infinity
                                : assignmentData.gradingEligibility
                                  .numRunsRemaining,
                              true,
                            ).replace("Infinity", "∞")}
                          </b>{" "}
                          remaining.
                        </p>
                      </span>
                    </OverlayTrigger>
                    <Button
                      onClick={onGradeClick} // 👈 MODIFIED: Using the new event handler
                      className="w-100"
                      disabled={!assignmentData.latestCommit}
                    >
                      Grade Assignment
                    </Button>
                  </>
                )}
              </Card.Body>
            </Card>
            <Card className="mt-2">
              <Card.Header as="h4">Repository Information</Card.Header>
              <Card.Body>
                {assignmentData.latestCommit && (
                  <>
                    <b>Latest Commit: </b>
                    <code>
                      {assignmentData.latestCommit.sha.slice(0, 7)}
                    </code>{" "}
                    <br />
                    <b>Commit Message: </b>
                    <code>
                      {assignmentData.latestCommit.message.split("\n")[0]}
                    </code>{" "}
                    <br />
                    {assignmentData.latestCommit.date && (
                      <>
                        <b>Committed At: </b>
                        {moment(assignmentData.latestCommit.date).format(
                          dateTimeFormatString,
                        )}
                        {" ("}
                        {moment(assignmentData.latestCommit.date).fromNow()}
                        {")"}
                      </>
                    )}{" "}
                    <a
                      href={assignmentData.latestCommit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button
                        variant="outline-primary"
                        className="w-100 mt-3"
                        disabled={!assignmentData.latestCommit}
                      >
                        View Commit
                      </Button>
                    </a>
                  </>
                )}
                {!assignmentData.latestCommit && (
                  <p className="text-muted">
                    Repository not found, or there are no commits in your
                    repository.
                  </p>
                )}
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </Container>
    </>
  );
}

// ----------------------------------------------------------------
// --- 👇 ADDED: New Confirmation Modal Component ---
// ----------------------------------------------------------------
interface ConfirmRerunModalProps {
  show: boolean;
  handleClose: () => void;
  handleConfirm: () => void;
}

function ConfirmRerunModal({
  show,
  handleClose,
  handleConfirm,
}: ConfirmRerunModalProps): JSX.Element {
  return (
    <Modal show={show} onHide={handleClose}>
      <Modal.Header closeButton>
        <Modal.Title>Confirm Grading Run</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p>
          You haven't made any commits since your last grading run.
        </p>
        <p className="mb-0">
          Do you still want to use another run on the same version of your code?
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={handleConfirm}>
          Yes, Grade Anyway
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default function AssignmentHomePage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "", assignmentId = "" } = useParams<{
    courseId?: string;
    assignmentId?: string;
  }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const [gradeModal, setGradeModal] = useState<boolean>(false);
  const [resourceKey, setResourceKey] = useState<number>(0);
  // 👇 ADDED: State for the new confirmation modal
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  const isStaff = useMemo(() => {
    return courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF);
  }, [courseRoles]);

  useEffect(() => {
    if (!user) return;

    if (!courseId || !assignmentId || courseRoles.length === 0) {
      showAlert(
        "The specified assignment does not exist or you do not have access.",
        "danger",
      );
      navigate(formulateUrl("dashboard"));
      return;
    }
    const courseInfo = getCourseInfo(user, courseId);
    if (courseInfo) {
      setCourseInfoSessionStorage(courseInfo);
    } else {
      console.warn("Course info not found for user and courseId combination.");
    }
  }, [courseId, assignmentId, user, courseRoles, navigate, showAlert]);

  const assignmentResource = useMemo<
    Resource<AssignmentInformationResponse>
  >(() => {
    return createResource<AssignmentInformationResponse>(() =>
      getAssignmentData(courseId, assignmentId),
    );
  }, [courseId, assignmentId, user?.id, resourceKey]);


  const handleGradeClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) {
      setGradeModal(true);
      return;
    }

    try {
      const data = assignmentResource.read();
      const latestCommitDate = data.latestCommit?.date;

      if (data.studentRuns.length === 0 || !latestCommitDate) {
        setGradeModal(true);
        return;
      }

      const latestRun = [...data.studentRuns].sort(
        (a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime(),
      )[0];

      const noNewChanges = new Date(latestCommitDate) <= new Date(latestRun.scheduledAt);

      if (noNewChanges) {
        setShowConfirmModal(true);
      } else {
        setGradeModal(true);
      }
    } catch (e) {
      console.error("Error reading assignment data for confirmation:", e);
      setGradeModal(true);
    }
  };

  const handleGradeRequest = async (
    latestCommitHash: string
  ): Promise<void> => {
    if (!courseId || !assignmentId) {
      showAlert("Course ID or Assignment ID is missing.", "danger");
      setGradeModal(false);
      return;
    }

    let commitIsoTimestamp: string;
    try {
      const currentAssignmentData = assignmentResource.read();
      if (!currentAssignmentData.latestCommit?.date) {
        showAlert(
          "Cannot grade: Latest commit information or timestamp is missing.",
          "danger",
        );
        setGradeModal(false);
        return;
      }
      commitIsoTimestamp = new Date(
        currentAssignmentData.latestCommit.date,
      ).toISOString();
    } catch (e) {
      console.error("Error reading assignment data for commit timestamp:", e);
      showAlert(
        "Failed to retrieve commit data for grading. Please try again.",
        "danger",
      );
      setGradeModal(false);
      return;
    }

    try {
      const result = await fetch(
        formulateUrl(
          `api/v1/courses/${courseId}/assignment/${assignmentId}/grade`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueDate: commitIsoTimestamp, expectedCommitHash: latestCommitHash }),
        },
      );

      if (!result.ok) {
        let errorMsg =
          "An unknown error occurred while starting the grading job.";
        try {
          const errorBody = await result.text();
          errorMsg = errorBody || errorMsg;
        } catch (parseError) {
          /* Ignore */
        }
        throw new Error(errorMsg);
      }
      showAlert("Grading job started!", "success"); // Updated message from previous step
      setResourceKey((prevKey) => prevKey + 1);
    } catch (e: unknown) {
      const errorMessage =
        e instanceof Error ? e.message : "An unexpected error occurred.";
      showAlert(`Grading job failed to start: ${JSON.parse(errorMessage).message}`, "danger");
    } finally {
      setGradeModal(false);
    }
  };

  const latestCommitForModal = useMemo(() => {
    if (gradeModal) {
      try {
        // Assuming assignmentResource is resolved because the page content
        // (AssignmentContent) that triggers the modal opening would have resolved it.
        const data = assignmentResource.read();
        return data.latestCommit;
      } catch (error) {
        // This catch is for any unexpected errors during the .read() call.
        // Suspension (Promise being thrown) is not expected here due to the rendering flow.
        console.error("Error accessing latestCommit for modal:", error);
        return null; // Or undefined, depending on GradeAssignmentModal's prop type
      }
    }
    return null; // Or undefined
  }, [gradeModal, assignmentResource]);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <AssignmentContent
            assignmentResource={assignmentResource}
            courseId={courseId}
            assignmentId={assignmentId}
            isStaff={isStaff}
            onGradeClick={handleGradeClick} // 👈 MODIFIED: Pass the new handler
            navigate={navigate}
          />
        </Suspense>
      </ErrorBoundary>

      <GradeAssignmentModal
        show={gradeModal}
        latestCommit={latestCommitForModal}
        handleClose={() => setGradeModal(false)}
        handleGrade={handleGradeRequest}
      />
      <ConfirmRerunModal
        show={showConfirmModal}
        handleClose={() => setShowConfirmModal(false)}
        handleConfirm={() => {
          setShowConfirmModal(false);
          setGradeModal(true); // Open the main grade modal on confirm
        }}
      />
    </div>
  );
}
