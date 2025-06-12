import {
  useState,
  useEffect,
  Suspense,
  useMemo,
  // useCallback, // Not directly used in parent, but in Content
  Dispatch,
  SetStateAction,
  useRef, // Added for file input
} from "react";
import {
  Container,
  Card,
  Button,
  Row,
  Col,
  Table,
  Modal,
  Form,
  Badge,
  InputGroup,
  Spinner,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  createResource,
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
import Papa from "papaparse";
import { OverwriteStudentRosterBody } from "../../types/roster";

// --- Types specific to this page ---
interface RosterUser {
  netId: string;
  role: Role;
  uin?: string;
  name?: string;
}
interface Student extends RosterUser {
  originalName?: string;
  originalUin?: string;
}

interface ManageRosterResponse {
  operationStatus: string; // e.g., "SUCCESS", "PARTIAL_SUCCESS", "FAILURE"
  message?: string; // Overall message from the backend
  results: Array<{ netId: string; status: string; message?: string }>;
}

interface RosterUserPayload {
  netId: string;
  role: Role;
  name?: string;
  uin?: string;
}

interface CourseRosterPageData {
  courseDetails: CourseInformationResponse;
  initialRoster: Student[];
}

async function fetchCourseDetailsInternal(
  courseId: string,
): Promise<CourseInformationResponse> {
  if (!courseId)
    throw new Error("Course ID is missing for fetching course details.");
  const response = await fetch(formulateUrl(`api/v1/courses/${courseId}`));
  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(
      `Failed to fetch course data: ${response.statusText} - ${errorText}`,
    );
  }
  return (await response.json()) as CourseInformationResponse;
}

async function fetchCourseRosterInternal(
  courseId: string,
): Promise<RosterUser[]> {
  if (!courseId) throw new Error("Course ID is missing for fetching roster.");
  const response = await fetch(formulateUrl(`api/v1/roster/${courseId}/all`));
  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => `HTTP error ${response.status}`);
    throw new Error(
      `Failed to fetch course roster: ${response.statusText} - ${errorText}`,
    );
  }
  return (await response.json()) as RosterUser[];
}

async function manageRosterAPI(
  courseId: string,
  action: "add" | "disable",
  users: RosterUserPayload[],
): Promise<ManageRosterResponse> {
  if (!courseId) throw new Error("Course ID is missing for managing roster.");
  const response = await fetch(formulateUrl(`api/v1/roster/${courseId}/all`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, users }),
  });
  const responseBody = await response.json();
  if (!response.ok) {
    throw new Error(
      responseBody.message ||
        `Failed to ${action} users: ${response.statusText}`,
    );
  }
  return responseBody as ManageRosterResponse;
}

async function getCourseRosterPageData(
  courseId: string,
): Promise<CourseRosterPageData> {
  const [courseDetails, rawRoster] = await Promise.all([
    fetchCourseDetailsInternal(courseId),
    fetchCourseRosterInternal(courseId),
  ]);
  const initialRoster: Student[] = rawRoster.map((u) => ({
    ...u,
    originalName: u.name,
    originalUin: u.uin,
  }));
  return { courseDetails, initialRoster };
}

// --- Content Component (handles UI, local state, and interactions) ---
interface CourseRosterContentProps {
  rosterPageResource: Resource<CourseRosterPageData>;
  courseId: string;
  currentUserNetId: string | undefined;
  isAdmin: boolean;
  showAlert: ReturnType<typeof useAlert>["showAlert"];
  setResourceKey: Dispatch<SetStateAction<number>>;
}

function CourseRosterContent({
  rosterPageResource,
  courseId,
  currentUserNetId,
  isAdmin,
  showAlert,
  setResourceKey,
}: CourseRosterContentProps) {
  const { courseDetails, initialRoster } = rosterPageResource.read();

  const [localRoster, setLocalRoster] = useState<Student[]>(initialRoster);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [newUserNetId, setNewUserNetId] = useState("");
  const [newUserRole, setNewUserRole] = useState<Role>(Role.STUDENT);
  const [newUserName, setNewUserName] = useState("");
  const [newUserUIN, setNewUserUIN] = useState("");
  const [isProcessing, setIsProcessing] = useState(false); // General processing state

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<() => Promise<void>>(() =>
    Promise.resolve(),
  );
  const [confirmNetIdToAction, setConfirmNetIdToAction] = useState("");
  const [confirmTitle, setConfirmTitle] = useState("");
  const [showStudentDetails, setShowStudentDetails] = useState(false);

  // --- CSV Import States ---
  const [isImportingCsv, setIsImportingCsv] = useState(false); // Specific for CSV button loading
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showCsvConfirmModal, setShowCsvConfirmModal] = useState(false);
  const [csvUsersToConfirm, setCsvUsersToConfirm] =
    useState<OverwriteStudentRosterBody>([]);

  useEffect(() => {
    setLocalRoster(initialRoster);
  }, [initialRoster]);

  async function overwriteStudentRoster(
    courseId: string,
    data: OverwriteStudentRosterBody,
  ) {
    if (!courseId)
      throw new Error("Course ID is missing for overwriting roster.");
    const response = await fetch(
      formulateUrl(`api/v1/roster/${courseId}/students`),
      {
        method: "POST",
        body: JSON.stringify(data),
        headers: { "content-type": "application/json" },
      },
    );
    if (!response.ok) {
      let errorMessage = `Failed to overwrite roster. Status: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorData.detail || errorMessage;
      } catch (e) {}
      throw new Error(errorMessage);
    }
  }

  const handleAddUser = async () => {
    if (!isAdmin) return;
    if (!newUserNetId.trim()) {
      showAlert("NetID is required.", "warning");
      return;
    }
    if (
      newUserRole === Role.STUDENT &&
      (!newUserName.trim() || !newUserUIN.trim())
    ) {
      showAlert("Students require a Name and UIN.", "warning");
      return;
    }
    setIsProcessing(true);
    const userData: RosterUserPayload = {
      netId: newUserNetId.trim(),
      role: newUserRole,
      name: newUserName.trim() || undefined,
      uin: newUserUIN.trim() || undefined,
    };
    try {
      const response = await manageRosterAPI(courseId, "add", [userData]);
      showAlert(
        response.results[0]?.message ||
          response.results[0]?.status ||
          "User action processed.",
        "success",
      );
      setNewUserNetId("");
      setNewUserName("");
      setNewUserUIN("");
      setNewUserRole(Role.STUDENT);
      setShowAddUserModal(false);
      setResourceKey((k) => k + 1);
    } catch (error) {
      showAlert((error as Error).message || "Failed to add user.", "danger");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUpdateStudentDetails = async (studentToUpdate: Student) => {
    // ... (existing handleUpdateStudentDetails logic)
    if (!isAdmin) return;
    if (
      studentToUpdate.role === Role.STUDENT &&
      (!studentToUpdate.name?.trim() || !studentToUpdate.uin?.trim())
    ) {
      showAlert("Student name and UIN cannot be empty.", "warning");
      setLocalRoster((prev) =>
        prev.map((s) =>
          s.netId === studentToUpdate.netId
            ? { ...s, name: s.originalName, uin: s.originalUin }
            : s,
        ),
      );
      return;
    }
    setIsProcessing(true);
    const payload: RosterUserPayload = {
      netId: studentToUpdate.netId,
      role: studentToUpdate.role,
      name: studentToUpdate.name?.trim(),
      uin: studentToUpdate.uin?.trim() || undefined,
    };
    try {
      const response = await manageRosterAPI(courseId, "add", [payload]);
      showAlert(
        response.results[0]?.message ||
          response.results[0]?.status ||
          "Details update processed.",
        "success",
      );
      setResourceKey((k) => k + 1);
    } catch (error) {
      showAlert(
        (error as Error).message || "Failed to update student details.",
        "danger",
      );
      setResourceKey((k) => k + 1); // Refresh even on error to revert optimistic UI or show actual state
    } finally {
      setIsProcessing(false);
    }
  };

  const showRemoveUserConfirmation = (netIdToRemove: string) => {
    // ... (existing showRemoveUserConfirmation logic)
    if (!isAdmin) return;
    const userToRemove = localRoster.find((u) => u.netId === netIdToRemove);
    if (!userToRemove) return;
    setConfirmTitle(`Disable User: ${netIdToRemove}`);
    setConfirmNetIdToAction(netIdToRemove);
    setConfirmAction(() => async () => {
      setIsProcessing(true);
      try {
        const response = await manageRosterAPI(courseId, "disable", [
          { netId: userToRemove.netId, role: userToRemove.role },
        ]);
        showAlert(
          response.results[0]?.message ||
            response.results[0]?.status ||
            "User disabled.",
          "success",
        );
        setResourceKey((k) => k + 1);
      } catch (error) {
        showAlert(
          (error as Error).message || "Failed to disable user.",
          "danger",
        );
      } finally {
        setIsProcessing(false);
        setShowConfirmModal(false);
      }
    });
    setShowConfirmModal(true);
  };

  const handleLocalStudentChange = (
    netId: string,
    field: "name" | "uin" | "role",
    value: string,
  ) => {
    // ... (existing handleLocalStudentChange logic)
    if (!isAdmin) return;
    setLocalRoster((prevRoster) =>
      prevRoster.map((student) =>
        student.netId === netId ? { ...student, [field]: value } : student,
      ),
    );
  };

  const handleCsvFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!isAdmin) return;
    const file = event.target.files?.[0];

    if (!file) {
      showAlert("No file selected.", "info");
      return;
    }
    if (
      file.type !== "text/csv" &&
      !file.name.toLowerCase().endsWith(".csv") &&
      file.type !== "application/vnd.ms-excel"
    ) {
      showAlert(
        "Please upload a valid CSV file (e.g., .csv format).",
        "warning",
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsImportingCsv(true);
    showAlert("Processing CSV file...", "info", 3000);

    try {
      const fileContent = await file.text(); // 1. Read file as text

      // 2. Pre-process the string: remove lines without commas
      const lines = fileContent.split(/\r\n|\n/);
      const linesWithCommas = lines.filter((line) => line.includes(","));

      if (linesWithCommas.length === 0) {
        throw new Error(
          "No data lines with commas found. The file might be empty, not comma-separated, or only contain a header without commas.",
        );
      }

      // Ensure the first line (potential header) actually has content
      const firstPotentialHeader = linesWithCommas[0].trim();
      if (!firstPotentialHeader) {
        throw new Error(
          "The first line identified as a potential header (contains commas) is empty or whitespace. Cannot determine headers.",
        );
      }

      const preprocessedCsvString = linesWithCommas.join("\n"); // 3. Join back into a string

      // 4. Pass the processed string to Papa.parse()
      Papa.parse<Record<string, string>>(preprocessedCsvString, {
        header: true,
        skipEmptyLines: "greedy", // Still useful for any truly empty lines *within* the comma-containing data
        dynamicTyping: false,
        complete: (results) => {
          try {
            if (results.errors && results.errors.length > 0) {
              const errorMessages = results.errors
                .map((err) => {
                  let baseMessage = err.message;
                  if (err.row !== undefined) {
                    // row is 0-indexed data row (after header) from preprocessed data
                    baseMessage += ` (at approx. data row ${err.row + 1} of preprocessed data)`;
                  }
                  return baseMessage;
                })
                .join("; ");
              console.error(
                "CSV Parsing errors from PapaParse (on preprocessed data):",
                results.errors,
              );
              throw new Error(
                `Issues found during CSV parsing: ${errorMessages}`,
              );
            }

            const parsedData = results.data;
            const headers = results.meta.fields as string[] | undefined;

            if (!headers || headers.length === 0) {
              throw new Error(
                "CSV has no headers or is empty after pre-processing and parsing.",
              );
            }
            // It's possible to have a header but no data rows, which might be valid.
            // The check for finalUsers.length > 0 later will handle if no actual users were extracted.

            const findHeaderKey = (
              desiredHeaders: string[],
              actualHeaders: string[],
            ): string | undefined => {
              const lowerActualHeaders = actualHeaders.map((h) =>
                h.toLowerCase().trim(),
              );
              for (const desired of desiredHeaders) {
                const lowerDesired = desired.toLowerCase();
                const index = lowerActualHeaders.indexOf(lowerDesired);
                if (index !== -1) {
                  return actualHeaders[index];
                }
              }
              return undefined;
            };

            const netIdHeaderKey = findHeaderKey(["netid", "net id"], headers);
            const nameHeaderKey = findHeaderKey(["name", "full name"], headers);
            const uinHeaderKey = findHeaderKey(["uin"], headers);

            if (!netIdHeaderKey || !nameHeaderKey || !uinHeaderKey) {
              const missing: string[] = [];
              if (!netIdHeaderKey) missing.push("'NetID' (or 'Net ID')");
              if (!nameHeaderKey) missing.push("'Name' (or 'Full Name')");
              if (!uinHeaderKey) missing.push("'UIN'");
              throw new Error(
                `CSV header (first line with commas) must include ${missing.join(", ")} columns.`,
              );
            }

            const uniqueUsersOutputMap = new Map<string, RosterUserPayload>();
            for (const row of parsedData) {
              if (
                Object.keys(row).length === 0 ||
                Object.values(row).every(
                  (val) => val === null || String(val).trim() === "",
                )
              ) {
                console.warn(
                  "Skipping empty or effectively empty row from parsed data:",
                  row,
                );
                continue;
              }

              const netId = String(row[netIdHeaderKey] || "").trim();
              const name = String(row[nameHeaderKey] || "").trim();
              const uin = String(row[uinHeaderKey] || "").trim();

              if (netId && name && uin) {
                uniqueUsersOutputMap.set(netId, {
                  netId,
                  name,
                  uin,
                  role: Role.STUDENT,
                });
              } else {
                console.warn(
                  "Skipping CSV row due to missing NetID, Name, or UIN after processing. Row data:",
                  row,
                );
              }
            }

            const finalUsers = Array.from(uniqueUsersOutputMap.values());
            if (finalUsers.length > 0) {
              setCsvUsersToConfirm(
                finalUsers as { netId: string; uin: string; name: string }[],
              );
              setShowCsvConfirmModal(true);
            } else {
              showAlert(
                "No valid user data extracted from CSV. Ensure required columns (NetID, Name, UIN) exist and contain data in the rows following the header.",
                "warning",
              );
            }
          } catch (err) {
            showAlert(
              `Error processing CSV data: ${(err as Error).message}`,
              "danger",
            );
            console.error(
              "CSV Data Processing Error (within 'complete' callback):",
              err,
            );
          } finally {
            setIsImportingCsv(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }
        },
        error: (error: any, fileFromError: File) => {
          console.error(
            "PapaParse fatal error:",
            error,
            "File being parsed:",
            fileFromError,
          ); // fileFromError here is the string
          showAlert(`Failed to parse CSV file: ${error.message}`, "danger");
          setIsImportingCsv(false);
          if (fileInputRef.current) fileInputRef.current.value = "";
        },
      });
    } catch (preprocessError) {
      // Catch errors from file.text() or initial pre-processing
      showAlert(
        `Failed to read or preprocess CSV file: ${(preprocessError as Error).message}`,
        "danger",
      );
      console.error("CSV Reading/Preprocessing Error:", preprocessError);
      setIsImportingCsv(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleConfirmCsvImport = async () => {
    if (!isAdmin || csvUsersToConfirm.length === 0) return;

    setIsProcessing(true); // Use general processing state for API call
    setShowCsvConfirmModal(false);

    const usersPayload: OverwriteStudentRosterBody = csvUsersToConfirm.map(
      (user) => ({
        netId: user.netId,
        name: user.name,
        uin: user.uin,
      }),
    );

    if (usersPayload.length === 0) {
      showAlert("No users selected for import.", "info");
      setIsProcessing(false);
      return;
    }

    try {
      await overwriteStudentRoster(courseId, usersPayload);
      setResourceKey((k) => k + 1);
    } catch (error) {
      showAlert(
        `Failed to import users from CSV: ${(error as Error).message}`,
        "danger",
      );
    } finally {
      setCsvUsersToConfirm([]);
      setIsProcessing(false);
    }
  };

  const staffRoster = localRoster.filter((u) => u.role !== Role.STUDENT);
  const studentRoster = localRoster.filter((u) => u.role === Role.STUDENT);
  const invalidStudents = isAdmin
    ? studentRoster.filter((u) => !u.name?.trim() || !u.uin?.trim())
    : [];
  const breadcrumb = {
    items: [
      {
        label: "Course Home",
        href: formulateUrl(`dashboard/${courseId}`),
      },
      { label: "Manage Roster" },
    ],
  };

  return (
    <>
      <AppNavbar title={courseDetails.name} breadcrumb={breadcrumb} />
      <Container className="p-3 mb-5 flex-grow-1">
        <Row className="mb-4 align-items-center">
          <Col>
            <h1>Course Roster</h1>
          </Col>
          {isAdmin && (
            <Col xs="auto" className="d-flex align-items-center">
              <Button
                variant="primary"
                onClick={() => setShowAddUserModal(true)}
                disabled={isProcessing || isImportingCsv}
                className="me-2"
              >
                Add User
              </Button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleCsvFileUpload}
                accept=".csv, text/csv"
                style={{ display: "none" }}
              />
            </Col>
          )}
        </Row>

        {/* ... (rest of the existing JSX for invalid students, staff roster, student roster) ... */}
        {isAdmin && invalidStudents.length > 0 && (
          <Card bg="warning" text="dark" className="mb-4">
            <Card.Header>
              <h5>Incomplete Student Records ({invalidStudents.length})</h5>
            </Card.Header>
            <Card.Body>
              <Card.Text>
                Please update student records missing a required name or UIN.{" "}
                {showStudentDetails
                  ? "You can edit them in the table below."
                  : "Expand student details to edit."}
              </Card.Text>
            </Card.Body>
          </Card>
        )}

        <Row className="mb-4">
          <Col>
            <h3>Staff ({staffRoster.length})</h3>
            <Card>
              <Card.Body
                className={
                  staffRoster.length === 0 ? "text-center text-muted" : ""
                }
              >
                {staffRoster.length > 0 ? (
                  <Table responsive striped bordered hover size="sm">
                    <thead>
                      <tr>
                        <th>NetID</th>
                        <th>Name</th>
                        <th>Role</th>
                        {isAdmin && <th>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {staffRoster.map((sUser) => (
                        <tr key={sUser.netId}>
                          <td>{sUser.netId}</td>
                          <td>
                            {isAdmin ? (
                              <InputGroup size="sm">
                                <Form.Control
                                  type="text"
                                  value={sUser.name || ""}
                                  onChange={(e) =>
                                    handleLocalStudentChange(
                                      sUser.netId,
                                      "name",
                                      e.target.value,
                                    )
                                  }
                                  disabled={isProcessing}
                                />
                              </InputGroup>
                            ) : (
                              sUser.name || <Badge bg="secondary">N/A</Badge>
                            )}
                          </td>
                          <td>
                            {isAdmin ? (
                              <Form.Select
                                size="sm"
                                value={sUser.role}
                                onChange={(e) =>
                                  handleLocalStudentChange(
                                    sUser.netId,
                                    "role",
                                    e.target.value,
                                  )
                                }
                                disabled={
                                  isProcessing ||
                                  sUser.netId === currentUserNetId
                                }
                              >
                                <option value={Role.ADMIN}>Admin</option>
                                <option value={Role.STAFF}>Staff</option>
                              </Form.Select>
                            ) : (
                              <Badge
                                pill
                                bg={
                                  sUser.role === Role.ADMIN
                                    ? "danger"
                                    : "primary"
                                }
                              >
                                {sUser.role}
                              </Badge>
                            )}
                          </td>
                          {isAdmin && (
                            <td>
                              <Button
                                variant="outline-success"
                                size="sm"
                                className="me-2"
                                onClick={() =>
                                  handleUpdateStudentDetails(sUser)
                                }
                                disabled={isProcessing}
                                title="Save student details"
                              >
                                Save
                              </Button>
                              <Button
                                variant="outline-danger"
                                size="sm"
                                onClick={() =>
                                  showRemoveUserConfirmation(sUser.netId)
                                }
                                disabled={
                                  isProcessing ||
                                  sUser.netId === currentUserNetId
                                }
                              >
                                Disable
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p>No staff members found.</p>
                )}
              </Card.Body>
            </Card>
          </Col>
        </Row>

        <Row>
          <Col>
            <div className="d-flex justify-content-between align-items-center mb-2">
              <h3>Students ({studentRoster.length})</h3>
              <div className="d-flex">
                {(isAdmin || studentRoster.length > 0) && (
                  <Button
                    variant="outline-secondary"
                    size="sm"
                    onClick={() => setShowStudentDetails(!showStudentDetails)}
                    disabled={studentRoster.length === 0 && !isAdmin}
                    className="me-2"
                  >
                    {showStudentDetails ? "Hide" : "Show"} Student Details
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessing || isImportingCsv}
                >
                  {isImportingCsv ? (
                    <Spinner as="span" size="sm" animation="border" />
                  ) : (
                    "Import Roster"
                  )}
                </Button>
              </div>
            </div>
            <Card>
              <Card.Body
                className={
                  ((showStudentDetails && studentRoster.length === 0) ||
                    studentRoster.length === 0) &&
                  !isAdmin
                    ? "text-center text-muted"
                    : ""
                }
              >
                {!showStudentDetails && studentRoster.length > 0 && (
                  <p className="text-muted">
                    Student details are currently hidden. Click "Show Student
                    Details" to view.
                  </p>
                )}
                {(showStudentDetails ||
                  (!isAdmin && studentRoster.length > 0)) &&
                studentRoster.length > 0 ? (
                  <Table responsive striped bordered hover size="sm">
                    <thead>
                      <tr>
                        <th>NetID</th>
                        <th>
                          Name{" "}
                          {isAdmin && <span className="text-danger">*</span>}
                        </th>
                        <th>
                          UIN{" "}
                          {isAdmin && <span className="text-danger">*</span>}
                        </th>
                        {isAdmin && <th>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {studentRoster.map((sUser) => (
                        <tr
                          key={sUser.netId}
                          className={
                            isAdmin &&
                            (!sUser.name?.trim() || !sUser.uin?.trim())
                              ? "table-warning"
                              : ""
                          }
                        >
                          <td>{sUser.netId}</td>
                          <td>
                            {isAdmin ? (
                              <InputGroup size="sm">
                                <Form.Control
                                  type="text"
                                  placeholder="Required"
                                  value={sUser.name || ""}
                                  onChange={(e) =>
                                    handleLocalStudentChange(
                                      sUser.netId,
                                      "name",
                                      e.target.value,
                                    )
                                  }
                                  isInvalid={!sUser.name?.trim()}
                                  disabled={isProcessing}
                                />
                              </InputGroup>
                            ) : (
                              sUser.name || <Badge bg="secondary">N/A</Badge>
                            )}
                          </td>
                          <td>
                            {isAdmin ? (
                              <InputGroup size="sm">
                                <Form.Control
                                  type="text"
                                  placeholder="Required"
                                  value={sUser.uin || ""}
                                  onChange={(e) =>
                                    handleLocalStudentChange(
                                      sUser.netId,
                                      "uin",
                                      e.target.value,
                                    )
                                  }
                                  isInvalid={!sUser.uin?.trim()}
                                  disabled={isProcessing}
                                />
                              </InputGroup>
                            ) : (
                              sUser.uin || <Badge bg="secondary">N/A</Badge>
                            )}
                          </td>
                          {isAdmin && (
                            <td>
                              <Button
                                variant="outline-success"
                                size="sm"
                                className="me-2"
                                onClick={() =>
                                  handleUpdateStudentDetails(sUser)
                                }
                                disabled={
                                  isProcessing ||
                                  !sUser.name?.trim() ||
                                  !sUser.uin?.trim()
                                }
                                title="Save student details"
                              >
                                Save
                              </Button>
                              <Button
                                variant="outline-danger"
                                size="sm"
                                onClick={() =>
                                  showRemoveUserConfirmation(sUser.netId)
                                }
                                disabled={isProcessing}
                              >
                                Disable
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  ((showStudentDetails &&
                    studentRoster.length === 0 &&
                    isAdmin) ||
                    studentRoster.length === 0) && (
                    <p className="text-center text-muted">No students found.</p>
                  )
                )}
                {isAdmin && showStudentDetails && studentRoster.length > 0 && (
                  <div className="text-muted small mt-2">
                    <span className="text-danger">*</span> Name and UIN are
                    required for students. Click "Save" per row to update.
                  </div>
                )}
              </Card.Body>
            </Card>
          </Col>
        </Row>

        <Modal // Add User Modal
          show={showAddUserModal}
          onHide={() => !isProcessing && setShowAddUserModal(false)}
          keyboard={!isProcessing}
        >
          <Modal.Header closeButton={!isProcessing}>
            <Modal.Title>Add New User</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                handleAddUser();
              }}
            >
              <Form.Group className="mb-3">
                <Form.Label>
                  NetID <span className="text-danger">*</span>
                </Form.Label>
                <Form.Control
                  type="text"
                  placeholder="Enter NetID"
                  value={newUserNetId}
                  onChange={(e) => setNewUserNetId(e.target.value)}
                  required
                  disabled={isProcessing}
                />
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>
                  Role <span className="text-danger">*</span>
                </Form.Label>
                <Form.Select
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value as Role)}
                  disabled={isProcessing}
                >
                  <option value={Role.STUDENT}>Student</option>
                  <option value={Role.STAFF}>Staff</option>
                  <option value={Role.ADMIN}>Admin</option>
                </Form.Select>
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>
                  Name{" "}
                  {newUserRole === Role.STUDENT && (
                    <span className="text-danger">*</span>
                  )}
                </Form.Label>
                <Form.Control
                  type="text"
                  placeholder="Enter Full Name"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  required={newUserRole === Role.STUDENT}
                  disabled={isProcessing}
                />
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>
                  UIN{" "}
                  {newUserRole === Role.STUDENT && (
                    <span className="text-danger">*</span>
                  )}
                </Form.Label>
                <Form.Control
                  type="text"
                  placeholder="Enter UIN"
                  value={newUserUIN}
                  onChange={(e) => setNewUserUIN(e.target.value)}
                  required={newUserRole === Role.STUDENT}
                  disabled={isProcessing}
                />
              </Form.Group>
              <div className="text-muted small mt-2">
                <span className="text-danger">*</span> Required fields. Student
                Name and UIN are mandatory.
              </div>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => setShowAddUserModal(false)}
              disabled={isProcessing}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleAddUser}
              disabled={
                !newUserNetId.trim() ||
                isProcessing ||
                (newUserRole === Role.STUDENT &&
                  (!newUserName.trim() || !newUserUIN.trim()))
              }
            >
              {isProcessing ? (
                <Spinner as="span" size="sm" animation="border" />
              ) : (
                "Add User"
              )}
            </Button>
          </Modal.Footer>
        </Modal>

        <ConfirmationModal // Generic Confirmation Modal
          show={showConfirmModal}
          title={confirmTitle}
          message={
            <p>
              Are you sure you want to modify user{" "}
              <code>{confirmNetIdToAction}</code>?{" "}
              <b>
                This action is not reversible and will result in data removal -
                your NetID will be logged with this action.
              </b>
            </p>
          }
          confirmText="Confirm"
          isProcessing={isProcessing}
          onConfirm={confirmAction}
          onCancel={() => setShowConfirmModal(false)}
        />

        <Modal // CSV Import Confirmation Modal
          show={showCsvConfirmModal}
          onHide={() =>
            !(isProcessing || isImportingCsv) && setShowCsvConfirmModal(false)
          }
          size="lg"
          keyboard={!(isProcessing || isImportingCsv)}
        >
          <Modal.Header closeButton={!(isProcessing || isImportingCsv)}>
            <Modal.Title>Confirm CSV Import</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {csvUsersToConfirm.length > 0 ? (
              <>
                <p>
                  Found <strong>{csvUsersToConfirm.length} unique users</strong>{" "}
                  from the CSV. They will be imported/updated with the role{" "}
                  <strong>Student</strong>. Please review the users below before
                  proceeding.
                </p>
                <Table striped bordered hover size="sm" responsive>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>NetID</th>
                      <th>Name</th>
                      <th>UIN</th>
                      <th>Anticipated Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvUsersToConfirm.map((user, index) => {
                      const existingUser = localRoster.find(
                        (eu) => eu.netId === user.netId,
                      );
                      let statusBadge;
                      if (existingUser) {
                        if (
                          existingUser.name !== user.name ||
                          existingUser.uin !== user.uin
                        ) {
                          statusBadge = (
                            <Badge bg="info" text="dark">
                              Update
                            </Badge>
                          );
                        } else {
                          statusBadge = <Badge bg="secondary">No Change</Badge>;
                        }
                      } else {
                        statusBadge = <Badge bg="success">Add New</Badge>;
                      }
                      return (
                        <tr key={`${user.netId}-${index}`}>
                          {" "}
                          {/* Ensure key is unique if netids could somehow not be */}
                          <td>{index + 1}</td>
                          <td>{user.netId}</td>
                          <td>{user.name}</td>
                          <td>{user.uin}</td>
                          <td>{statusBadge}</td>
                        </tr>
                      );
                    })}
                    {localRoster
                      .filter((x) => x.role === Role.STUDENT)
                      .map((user, index) => {
                        const isInCsv = csvUsersToConfirm.find(
                          (eu) => eu.netId === user.netId,
                        );
                        let statusBadge;
                        if (!isInCsv) {
                          statusBadge = <Badge bg="danger">Disable</Badge>;
                          return (
                            <tr key={`${user.netId}-${index}`}>
                              <td>{index + 1}</td>
                              <td>{user.netId}</td>
                              <td>{user.name}</td>
                              <td>{user.uin}</td>
                              <td>{statusBadge}</td>
                            </tr>
                          );
                        }
                        return null;
                      })}
                  </tbody>
                </Table>
              </>
            ) : (
              <p>No valid new users to import.</p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => setShowCsvConfirmModal(false)}
              disabled={isProcessing || isImportingCsv}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirmCsvImport}
              disabled={
                isProcessing || isImportingCsv || csvUsersToConfirm.length === 0
              }
            >
              {isProcessing ? (
                <Spinner as="span" size="sm" animation="border" />
              ) : (
                "Process Roster Update"
              )}
            </Button>
          </Modal.Footer>
        </Modal>
      </Container>
    </>
  );
}

// --- Main Page Component (Shell) ---
export default function CourseRosterPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const [resourceKey, setResourceKey] = useState<number>(0);

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
  const currentUserNetId = useMemo(() => user?.email?.split("@")[0], [user]);

  useEffect(() => {
    if (!user) return;
    if (!courseId || !isStaffOrAdmin) {
      showAlert(
        "You do not have permission to view this page or the course ID is invalid.",
        "danger",
      );
      navigate(formulateUrl("dashboard"));
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Roster | ${courseInfo.courseName}`;
  }, [courseId, user, isStaffOrAdmin, navigate, showAlert]);

  const rosterPageResource = useMemo<Resource<CourseRosterPageData>>(() => {
    if (!courseId || !isStaffOrAdmin) {
      return createResource<CourseRosterPageData>(() =>
        Promise.reject(
          new Error(
            "Access denied or prerequisites not met for loading roster data.",
          ),
        ),
      );
    }
    return createResource<CourseRosterPageData>(() =>
      getCourseRosterPageData(courseId),
    );
  }, [courseId, isStaffOrAdmin, user?.id, resourceKey]);

  if (!user) {
    return <LoadingScreen message="Loading user data..." />;
  }
  if (!courseId || !isStaffOrAdmin) {
    return <LoadingScreen message="Checking permissions..." />;
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <CourseRosterContent
            rosterPageResource={rosterPageResource}
            courseId={courseId}
            currentUserNetId={currentUserNetId}
            isAdmin={isAdmin}
            showAlert={showAlert}
            setResourceKey={setResourceKey}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
