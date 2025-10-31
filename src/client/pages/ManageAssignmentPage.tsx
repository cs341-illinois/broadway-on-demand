import {
  useState,
  useEffect,
  Suspense,
  useMemo,
  Dispatch,
  SetStateAction,
} from "react";
import {
  Container,
  Card,
  Button,
  Row,
  Col,
  Spinner,
  Table,
  Tabs,
  Tab,
  Form,
  // OverlayTrigger, // Not used in this modification
  // Tooltip, // Not used in this modification
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  attemptFormatEnum,
  createResource,
  dateTimeFormatString,
  formatDateForDateTimeLocalInput,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  getTimeZoneName,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import ConfirmationModal from "../components/ConfirmationModal";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";
import ExtensionModal from "../components/CreateExtensionModal";
import AssignmentModal from "../components/CreateAssignmentModal";
import JobLogModal from "../components/JobLogModal"; // Import the new modal component

import {
  AssignmentExtensionBody,
  AssignmentResponseEntry,
  AssignmentRuns,
  JobStatusColors,
  JobStatusLabels,
  JobTypeLabels,
  UpdateAssignmentBody,
} from "../../types/assignment";
import { AutogradableCategory, ExtensionInitiator, JobType, Role } from "../enums";
import moment from "moment-timezone";
import pluralize from "pluralize";
import { AssignmentExtensionsGetResponse } from "../../types/extension";
import { FullRoleEntry } from "../../types/index";

type RunEntry = AssignmentRuns[number];

interface ManageAssignmentPageData {
  assignmentDetails: AssignmentResponseEntry;
}

export async function getJobLog(
  courseId: string,
  assignmentId: string,
  runId: string,
  netId: string,
): Promise<string> {
  const response = await fetch(
    formulateUrl(
      `api/v1/courses/${courseId}/assignment/${assignmentId}/run/${runId}/user/${netId}/log`,
    ),
  );
  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(
      `Failed to fetch job log for run ${runId}: ${response.statusText} - ${errorText}`,
    );
  }
  const logText = await response.text();
  return logText || "Log is empty or not available.";
}

async function fetchAssignmentDetailsInternal(
  courseId: string,
  assignmentId: string,
): Promise<AssignmentResponseEntry> {
  if (!courseId || !assignmentId) {
    throw new Error(
      "Course ID or Assignment ID is missing for fetching assignment details.",
    );
  }
  const response = await fetch(
    formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}/raw`),
  );
  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(
      `Failed to fetch assignment data: ${response.statusText} - ${errorText}`,
    );
  }
  return (await response.json()) as AssignmentResponseEntry;
}

async function getManageAssignmentPageData(
  courseId: string,
  assignmentId: string,
): Promise<ManageAssignmentPageData> {
  const assignmentDetails = await fetchAssignmentDetailsInternal(
    courseId,
    assignmentId,
  );
  return { assignmentDetails };
}

async function getRuns(
  courseId: string,
  assignmentId: string,
): Promise<AssignmentRuns> {
  const response = await fetch(
    formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}/runs`),
  );
  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(
      `Failed to fetch assignment runs: ${response.statusText} - ${errorText}`,
    );
  }
  return (await response.json()) as AssignmentRuns;
}

async function getExtensions(
  courseId: string,
  assignmentId: string,
): Promise<AssignmentExtensionsGetResponse> {
  const response = await fetch(
    formulateUrl(`api/v1/extension/${courseId}/assignment/${assignmentId}`),
  );
  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(
      `Failed to get extensions: ${response.statusText} - ${errorText}`,
    );
  }
  return (await response.json()) as AssignmentExtensionsGetResponse;
}

async function deleteExtension(
  courseId: string,
  assignmentId: string,
  extensionId: string,
): Promise<AssignmentExtensionsGetResponse> {
  const response = await fetch(
    formulateUrl(
      `api/v1/extension/${courseId}/assignment/${assignmentId}/id/${extensionId}`,
    ),
    { method: "DELETE" },
  );
  if (!response.ok) {
    const errorText = await response
      .json()
      .then((i) => i.message)
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(`Failed to delete extension - ${errorText}`);
  }
  return (await response.json()) as AssignmentExtensionsGetResponse;
}

async function markExtensionExempt(
  courseId: string,
  assignmentId: string,
  extensionId: string,
): Promise<undefined> {
  const response = await fetch(
    formulateUrl(
      `api/v1/extension/${courseId}/assignment/${assignmentId}/id/${extensionId}/refundStudentExtension`,
    ),
    { method: "POST" },
  );
  if (!response.ok) {
    const errorText = await response
      .json()
      .then((i) => i.message)
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(`Failed to exempt extension - ${errorText}`);
  }
  return;
}

interface ManageAssignmentContentProps {
  pageResource: Resource<ManageAssignmentPageData>;
  jobsResource: Resource<AssignmentRuns>;
  extensionsResource: Resource<AssignmentExtensionsGetResponse>;
  courseInfo: FullRoleEntry;
  assignmentId: string;
  showAlert: ReturnType<typeof useAlert>["showAlert"];
  setResourceKey: Dispatch<SetStateAction<number>>;
  navigate: ReturnType<typeof useNavigate>;
}

type GroupedRuns = {
  [netId: string]: RunEntry[];
};

export function groupRunsByNetId(runs: RunEntry[]): GroupedRuns {
  const groupedRuns: GroupedRuns = {};
  if (!runs) return groupedRuns;

  for (const run of runs) {
    if (run.netId && Array.isArray(run.netId)) {
      for (const individualNetId of run.netId) {
        if (!groupedRuns[individualNetId]) {
          groupedRuns[individualNetId] = [];
        }
        groupedRuns[individualNetId].push(run);
      }
    }
  }
  return groupedRuns;
}

function ManageAssignmentContent({
  pageResource,
  jobsResource,
  courseInfo,
  assignmentId,
  extensionsResource,
  showAlert,
  setResourceKey,
  navigate,
}: ManageAssignmentContentProps) {
  const { courseId, courseName } = courseInfo;
  const { user } = useAuth();

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  const isAdmin = useMemo(
    () => courseRoles.includes(Role.ADMIN),
    [courseRoles],
  );

  const [activeTabKey, setActiveTabKey] = useState<JobType>(
    JobType.STUDENT_INITIATED,
  );
  const [searchTerm, setSearchTerm] = useState<string>("");

  const [currentJobLog, setCurrentJobLog] = useState<string | null>(null);
  const [loadingLogRunId, setLoadingLogRunId] = useState<string | null>(null);
  const [showJobLogModal, setShowJobLogModal] = useState<boolean>(false);
  const [selectedRunIdForModal, setSelectedRunIdForModal] = useState<
    string | null
  >(null);
  const [assignmentDetails, setAssignmentDetails] =
    useState<AssignmentResponseEntry>(pageResource.read().assignmentDetails);
  const [extensionDetails, setExtensionDetails] =
    useState<AssignmentExtensionsGetResponse>(extensionsResource.read());
  useEffect(() => {
    setExtensionDetails(extensionsResource.read());
  }, [extensionsResource]);
  useEffect(() => {
    setAssignmentDetails(pageResource.read().assignmentDetails);
  }, [assignmentDetails]);
  const [allRuns, setAllRuns] = useState<AssignmentRuns>(jobsResource.read());
  useEffect(() => {
    setAllRuns(jobsResource.read());
  }, [jobsResource]);
  const runCategories = useMemo(() => {
    const studentInitiated = allRuns.filter(
      (run) => run.type === JobType.STUDENT_INITIATED,
    );
    const finalGrading = allRuns.filter(
      (run) => run.type === JobType.FINAL_GRADING,
    );
    const regrade = allRuns.filter((run) => run.type === JobType.REGRADE);

    return [
      {
        key: JobType.STUDENT_INITIATED,
        title: JobTypeLabels.STUDENT_INITIATED,
        groupedData: groupRunsByNetId(studentInitiated),
        count: studentInitiated.length,
      },
      {
        key: JobType.FINAL_GRADING,
        title: JobTypeLabels.FINAL_GRADING,
        groupedData: groupRunsByNetId(finalGrading),
        count: finalGrading.length,
      },
      {
        key: JobType.REGRADE,
        title: JobTypeLabels.REGRADE,
        groupedData: groupRunsByNetId(regrade),
        count: regrade.length,
      },
    ];
  }, [allRuns]);

  const [extensionModalOpen, setExtensionModalOpen] = useState(false);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteExtensionInfo, setDeleteExtensionInfo] = useState<
    false | { id: string; netId: string }
  >(false);
  const [exemptExtensionInfo, setExemptExtensionInfo] = useState<
    false | { id: string; netId: string }
  >(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleUpdateAssignment = async (data: UpdateAssignmentBody) => {
    setIsProcessing(true);
    try {
      const response = await fetch(
        formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.message || "Failed to modify assignment.");
      }
      showAlert("Assignment modified!", "success");
      setAssignmentModalOpen(false);
      setResourceKey((k) => k + 1);
    } catch (error) {
      showAlert((error as Error).message, "danger");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteAssignment = async () => {
    setIsProcessing(true);
    try {
      const response = await fetch(
        formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}`),
        { method: "DELETE" },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.message || "Failed to delete assignment.");
      }
      showAlert("Assignment deleted!", "success");
      navigate(formulateUrl(`dashboard/${courseId}`));
    } catch (error) {
      showAlert((error as Error).message, "danger");
    } finally {
      setIsProcessing(false);
      setDeleteConfirmOpen(false);
    }
  };

  const handleCreateExtension = async (data: AssignmentExtensionBody) => {
    setIsProcessing(true);
    try {
      const response = await fetch(
        formulateUrl(
          `api/v1/extension/${courseId}/assignment/${assignmentId}/admin`,
        ),
        {
          method: "POST",
          body: JSON.stringify(data),
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.message || "Failed to create extension.");
      }
      showAlert("Extension created successfully!", "success");
    } catch (error) {
      showAlert((error as Error).message, "danger");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMarkExtensionExempt = async () => {
    if (!exemptExtensionInfo) {
      return;
    }
    setIsProcessing(true);
    try {
      await markExtensionExempt(courseId, assignmentId, exemptExtensionInfo.id);
      showAlert("Extension marked as exempt successfully!", "success");
      setResourceKey((prevKey) => prevKey + 1);
    } catch (error) {
      showAlert((error as Error).message, "danger");
    } finally {
      setIsProcessing(false);
      setExemptExtensionInfo(false);
    }
  };

  const handleViewLog = async (runId: string, netId: string) => {
    if (loadingLogRunId === runId) return; // Already loading this specific log

    setLoadingLogRunId(runId);
    setCurrentJobLog(null); // Clear previous log, also indicates loading for modal
    setSelectedRunIdForModal(runId);
    setShowJobLogModal(true); // Show modal immediately, it will display its own loading indicator or content

    try {
      const logData = await getJobLog(courseId, assignmentId, runId, netId);
      setCurrentJobLog(logData);
    } catch (error) {
      showAlert((error as Error).message, "danger");
      setCurrentJobLog(
        `Error fetching log for Run ID ${runId}:\n${(error as Error).message}`,
      );
    } finally {
      setLoadingLogRunId(null); // Stop button loading indicator
    }
  };

  const renderRunsTable = (groupedData: GroupedRuns) => {
    const filteredNetIds = Object.keys(groupedData).filter(
      (netId) =>
        netId.toLowerCase().includes(searchTerm.toLowerCase()) ||
        netId.toLowerCase() === "_all_",
    );

    if (filteredNetIds.length === 0) {
      return (
        <p className="text-muted mt-3">
          No runs found{searchTerm && " matching your search"} for this
          category.
        </p>
      );
    }

    return filteredNetIds.map((netId) => (
      <div key={netId} className="mb-4 mt-3">
        <h4>
          {netId === "_ALL_" ? "All Students" : <code>{netId}</code>} (
          {pluralize("run", groupedData[netId].length, true).replace(
            "Infinity",
            "∞",
          )}
          )
        </h4>
        <Table striped bordered hover responsive size="sm">
          <thead>
            <tr>
              <th>Events</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {groupedData[netId].map((run: RunEntry) => (
              <tr key={run.id}>
                <td>
                  <div>
                    {run.scheduledAt && (
                      <>
                        <b>Scheduled At:</b>{" "}
                        {moment(run.scheduledAt).format(dateTimeFormatString)}
                      </>
                    )}
                    {run.dueAt && (
                      <>
                        <br />
                        <b>Due At:</b>{" "}
                        {moment(run.dueAt).format(dateTimeFormatString)}
                      </>
                    )}
                  </div>
                </td>
                <td>
                  <p className={`mb-0 text-${JobStatusColors[run.status]}`}>
                    {JobStatusLabels[run.status].replace(
                      JobStatusLabels.PENDING,
                      "Scheduled",
                    )}
                  </p>
                </td>
                <td>
                  {run.buildUrl && (
                    <Button
                      className="me-2"
                      size="sm"
                      onClick={() => handleViewLog(run.id, netId)}
                      disabled={loadingLogRunId === run.id || isProcessing}
                    >
                      {loadingLogRunId === run.id ? (
                        <>
                          <Spinner
                            as="span"
                            animation="border"
                            size="sm"
                            role="status"
                            aria-hidden="true"
                            className="me-1"
                          />
                          Loading...
                        </>
                      ) : (
                        "View Log"
                      )}
                    </Button>
                  )}
                  {run.buildUrl && (
                    <Button
                      href={run.buildUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      size="sm"
                      variant="outline-info"
                    >
                      View Build
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    ));
  };

  return (
    <>
      <AppNavbar
        title={courseName}
        breadcrumb={{
          items: [
            {
              label: "Course Home",
              href: formulateUrl(`dashboard/${courseId}`),
            },
            {
              label: assignmentDetails.name,
              href: formulateUrl(
                `dashboard/${courseId}/assignment/${assignmentId}`,
              ),
            },
            { label: "Manage Assignment" },
          ],
        }}
      />
      <Container className="p-2 flex-grow-1">
        <h2>{assignmentDetails.name}</h2>
        <p className="text-muted">
          All timestamps shown in your local timezone ({getTimeZoneName()}).
        </p>
        <Row className="pt-3">
          <Col md={isAdmin ? 9 : 12} xs={12} className="mb-3 mb-md-0">
            <h3>Assignment Runs</h3>
            <Form.Group className="my-3">
              <Form.Control
                id="netIdSearch"
                type="text"
                placeholder="Enter NetID to filter..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </Form.Group>
            <Tabs
              activeKey={activeTabKey}
              onSelect={(k) =>
                setActiveTabKey((k as JobType) || JobType.STUDENT_INITIATED)
              }
              id="run-types-tabs"
              className="mb-3"
              justify
            >
              {runCategories.map(
                (category) =>
                  (category.count > 0 || category.key === activeTabKey) && (
                    <Tab
                      eventKey={category.key}
                      title={category.title}
                      key={category.key}
                      disabled={
                        category.count === 0 && category.key !== activeTabKey
                      }
                    >
                      {activeTabKey === category.key ? (
                        category.count > 0 ? (
                          renderRunsTable(category.groupedData)
                        ) : (
                          <p className="text-muted mt-3">
                            No {category.title.toLowerCase()} found.
                          </p>
                        )
                      ) : null}
                    </Tab>
                  ),
              )}
            </Tabs>
            {runCategories.every((cat) => cat.count === 0) && (
              <p className="text-muted mt-3">
                No runs found for this assignment.
              </p>
            )}
            <hr />
            <h3>Extensions</h3>
            {extensionDetails.length === 0 && (
              <p className="text-muted">No extensions found.</p>
            )}
            {extensionDetails.length > 0 && (
              <Table striped bordered hover responsive size="sm">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Open At</th>
                    <th>Close At</th>
                    <th>Final Grading Run Enabled</th>
                    <th>Extension Type</th>
                    <th>Created By</th>
                    {isAdmin ? <th>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {extensionDetails.map((x) => (
                    <tr key={x.id}>
                      <td>{x.netId}</td>
                      <td>{moment(x.openAt).format(dateTimeFormatString)}</td>
                      <td>{moment(x.closeAt).format(dateTimeFormatString)}</td>
                      <td>
                        {x.hasFinalGradingRun ? (
                          <p className="text-success">Yes</p>
                        ) : (
                          <p className="text-danger">No</p>
                        )}
                      </td>
                      <td>{attemptFormatEnum(x.extensionType)}</td>
                      <td>{x.createdBy}</td>
                      {isAdmin ? (
                        <td>
                          <Button
                            target="_blank"
                            rel="noopener noreferrer"
                            size="sm"
                            variant="outline-danger"
                            className="me-2"
                            onClick={(e) => {
                              e.preventDefault();
                              setDeleteExtensionInfo({
                                id: x.id,
                                netId: x.netId,
                              });
                            }}
                          >
                            Delete
                          </Button>
                          {isAdmin && x.extensionType === ExtensionInitiator.STUDENT && (
                            <Button
                              target="_blank"
                              rel="noopener noreferrer"
                              size="sm"
                              variant="outline-warning"
                              onClick={(e) => {
                                e.preventDefault();
                                setExemptExtensionInfo({
                                  id: x.id,
                                  netId: x.netId,
                                });
                              }}
                            >
                              Mark Exempt
                            </Button>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Col>
          {isAdmin && (
            <Col md={3} xs={12}>
              <Card>
                <Card.Header as="h5">Actions</Card.Header>
                <Card.Body>
                  <div className="d-grid gap-2">
                    <Button
                      onClick={() => setAssignmentModalOpen(true)}
                      disabled={isProcessing}
                    >
                      Modify Assignment
                    </Button>
                    {isAdmin && (
                      <Button
                        onClick={() => setExtensionModalOpen(true)}
                        disabled={isProcessing}
                      >
                        Create Extension
                      </Button>
                    )}
                    {isAdmin && (
                      <Button
                        onClick={() =>
                          navigate(
                            formulateUrl(
                              `dashboard/${courseId}/assignmentGrades?assignmentId=${assignmentId}`,
                            ),
                          )
                        }
                        disabled={isProcessing}
                      >
                        View Grades
                      </Button>
                    )}
                    <Button
                      onClick={() => setDeleteConfirmOpen(true)}
                      variant="danger"
                      disabled={isProcessing}
                    >
                      {isProcessing && deleteConfirmOpen ? (
                        <Spinner as="span" size="sm" animation="border" />
                      ) : (
                        "Delete Assignment"
                      )}
                    </Button>
                  </div>
                </Card.Body>
              </Card>
            </Col>
          )}
        </Row>
      </Container>

      <ExtensionModal
        show={extensionModalOpen}
        handleClose={() => !isProcessing && setExtensionModalOpen(false)}
        handleSubmit={(data) => {
          handleCreateExtension(data).then(() =>
            setResourceKey((prevKey) => prevKey + 1),
          );
        }}
        assignmentDue={new Date(assignmentDetails.dueAt)}
      />
      <AssignmentModal
        show={assignmentModalOpen}
        handleClose={() => !isProcessing && setAssignmentModalOpen(false)}
        handleSubmit={(data) => {
          handleUpdateAssignment(data).then(() =>
            setResourceKey((prevKey) => prevKey + 1),
          );
        }}
        initialData={{
          ...assignmentDetails,
          category: assignmentDetails.category as AutogradableCategory,
          openAt: formatDateForDateTimeLocalInput(
            new Date(assignmentDetails.openAt),
          ),
          dueAt: formatDateForDateTimeLocalInput(
            new Date(assignmentDetails.dueAt),
          ),
        }}
        verb={"Modify"}
      />
      <ConfirmationModal
        show={deleteConfirmOpen}
        onCancel={() => !isProcessing && setDeleteConfirmOpen(false)}
        isProcessing={isProcessing}
        onConfirm={handleDeleteAssignment}
        title="Confirm Delete"
        message="Are you sure you would like to delete this assignment? The data will be irrecoverable!"
      />
      <ConfirmationModal
        show={deleteExtensionInfo !== false}
        onCancel={() => !isProcessing && setDeleteExtensionInfo(false)}
        isProcessing={isProcessing}
        onConfirm={() => {
          if (!deleteExtensionInfo) {
            return;
          }
          try {
            deleteExtension(courseId, assignmentId, deleteExtensionInfo.id);
            showAlert("Extension deleted successfully!", "success");
            window.location.reload();
          } finally {
            setDeleteExtensionInfo(false);
          }
        }}
        title="Confirm Delete Extension"
        message={
          deleteExtensionInfo
            ? `Are you sure you would like to delete this extension for ${deleteExtensionInfo.netId}? The data will be irrecoverable!`
            : null
        }
      />
      <ConfirmationModal
        show={exemptExtensionInfo !== false}
        onCancel={() => !isProcessing && setExemptExtensionInfo(false)}
        isProcessing={isProcessing}
        onConfirm={handleMarkExtensionExempt}
        title="Confirm Mark Extension Exempt"
        message={
          exemptExtensionInfo
            ? `Are you sure you would like to mark this extension as exempt for ${exemptExtensionInfo.netId}? This extension will no longer count against their cap.`
            : null
        }
      />
      <JobLogModal
        show={showJobLogModal}
        handleClose={() => setShowJobLogModal(false)}
        logContent={currentJobLog}
        runId={selectedRunIdForModal}
      />
    </>
  );
}

export default function ManageAssignmentPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "", assignmentId = "" } = useParams<{
    courseId?: string;
    assignmentId?: string;
  }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const [courseInfo, setCourseInfo] = useState<FullRoleEntry | null>(null);

  const [resourceKey, setResourceKey] = useState<number>(0);

  const courseRoles = useMemo(() => {
    if (!user?.roles || !courseId) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user?.roles]);

  const isStaffOrAdmin = useMemo(
    () => courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF),
    [courseRoles],
  );

  useEffect(() => {
    if (!user) return;

    if (!courseId || !assignmentId) {
      showAlert("Course ID or Assignment ID is missing.", "danger");
      navigate(formulateUrl("dashboard"));
      return;
    }
    if (user && courseRoles.length === 0 && !isStaffOrAdmin) {
      showAlert(
        "You do not have permission to manage this assignment or the IDs are invalid.",
        "danger",
      );
      navigate(formulateUrl(`dashboard/${courseId || ""}`));
    }
    setCourseInfoSessionStorage(getCourseInfo(user, courseId)!);
    setCourseInfo(getCourseInfo(user, courseId));
  }, [
    courseId,
    assignmentId,
    user,
    isStaffOrAdmin,
    navigate,
    showAlert,
    courseRoles,
  ]);

  const pageResource = useMemo<Resource<ManageAssignmentPageData>>(() => {
    if (!courseId || !assignmentId || !isStaffOrAdmin || !user) {
      return createResource<ManageAssignmentPageData>(() =>
        Promise.reject(
          new Error(
            "Access denied or prerequisites not met for loading assignment data.",
          ),
        ),
      );
    }
    return createResource<ManageAssignmentPageData>(() =>
      getManageAssignmentPageData(courseId, assignmentId),
    );
  }, [courseId, assignmentId, isStaffOrAdmin, user, resourceKey]);

  const jobsResource = useMemo<Resource<AssignmentRuns>>(() => {
    if (!courseId || !assignmentId || !isStaffOrAdmin || !user) {
      return createResource<AssignmentRuns>(() =>
        Promise.reject(
          new Error(
            "Access denied or prerequisites not met for loading assignment runs.",
          ),
        ),
      );
    }
    return createResource<AssignmentRuns>(() =>
      getRuns(courseId, assignmentId),
    );
  }, [courseId, assignmentId, isStaffOrAdmin, user, resourceKey]);

  const extensionsResource = useMemo<
    Resource<AssignmentExtensionsGetResponse>
  >(() => {
    if (!courseId || !assignmentId || !isStaffOrAdmin || !user) {
      return createResource<AssignmentExtensionsGetResponse>(() =>
        Promise.reject(
          new Error(
            "Access denied or prerequisites not met for loading extensions.",
          ),
        ),
      );
    }
    return createResource<AssignmentExtensionsGetResponse>(() =>
      getExtensions(courseId, assignmentId),
    );
  }, [courseId, assignmentId, isStaffOrAdmin, user, resourceKey]);

  if (!user || !courseInfo) {
    return <LoadingScreen message="Loading user data..." />;
  }

  if (!isStaffOrAdmin && user) {
    return <LoadingScreen message="Verifying access..." />;
  }
  if (!courseId || !assignmentId) {
    return (
      <LoadingScreen message="Missing course or assignment information..." />
    );
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense
          fallback={
            <LoadingScreen message="Loading assignment management..." />
          }
        >
          <ManageAssignmentContent
            pageResource={pageResource}
            jobsResource={jobsResource}
            extensionsResource={extensionsResource}
            courseInfo={courseInfo}
            assignmentId={assignmentId}
            showAlert={showAlert}
            setResourceKey={setResourceKey}
            navigate={navigate}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
