import { useState, useEffect, useRef } from "react";
import AppNavbar from "../components/Navbar";
import {
  Col,
  Container,
  Row,
  Spinner,
  Form,
  InputGroup,
  Button,
  Table,
  ButtonGroup,
  Modal,
  Alert,
} from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import {
  capitalizeFirstLetterOnly,
  dateTimeFormatString,
  downloadText,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  getTimeZoneName,
  setCourseInfoSessionStorage,
} from "../utils";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import useDebounce from "../hooks/useDebounce";
import { FullRoleEntry } from "../../types/index";
import { LoadingScreen } from "../components/Loading";
import { AssignmentGrades } from "../../types/assignment";
import ManualAssignmentModal from "../components/CreateManualAssignmentModal";
import { AssignmentVisibility, Category } from "../enums";
import moment from "moment-timezone";
import { useAlert } from "../contexts/AlertContext";
import Papa, { ParseResult } from "papaparse";
import { GradeEntry } from "../../types/grades";

interface CsvGradeRowInput {
  [header: string]: string;
}

export default function AssignmentGradesPage() {
  const { user } = useAuth();
  const { courseId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [courseInfo, setCourseInfo] = useState<FullRoleEntry | null>(null);

  const [inputAssignmentId, setInputAssignmentId] = useState<string>("");
  const debouncedAssignmentId = useDebounce(inputAssignmentId, 300);

  const [assignmentInfo, setAssignmentInfo] = useState<AssignmentGrades | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [manualAssignmentModal, setManualAssignmentModal] =
    useState<boolean>(false);
  const { showAlert } = useAlert();

  // --- CSV Import States ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsedCsvData, setParsedCsvData] = useState<GradeEntry[]>([]);
  const [showCsvPreviewModal, setShowCsvPreviewModal] =
    useState<boolean>(false);
  const [isParsingCsv, setIsParsingCsv] = useState<boolean>(false);
  const [isUploadingGrades, setIsUploadingGrades] = useState<boolean>(false);

  useEffect(() => {
    const assignmentIdParam = searchParams.get("assignmentId");
    if (assignmentIdParam) {
      setInputAssignmentId(assignmentIdParam);
    }
  }, [searchParams]);

  async function getAssignmentGrades(courseId: string, assignmentId: string) {
    if (assignmentId) {
      setIsLoading(true);
      setAssignmentInfo(null);
    } else {
      setAssignmentInfo(null);
      setIsLoading(false);
      return null;
    }

    try {
      const response = await fetch(
        formulateUrl(
          `api/v1/courses/${courseId}/assignment/${assignmentId}/grades`,
        ),
      );
      if (!response.ok) {
        if (response.status === 404) {
          setIsLoading(false);
          setAssignmentInfo(null);
          return null;
        }
        setAssignmentInfo(null);
        showAlert(`Error fetching grades: ${response.statusText}`, "danger");
        return null;
      }
      const data = (await response.json()) as AssignmentGrades;
      setAssignmentInfo(data);
      return data;
    } catch (error) {
      showAlert(`Error fetching grades: ${(error as Error).message}`, "danger");
      setAssignmentInfo(null);
      return null;
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (
      !courseId ||
      getCourseRoles(courseId, user!.roles).length === 0 ||
      !getCourseRoles(courseId, user!.roles).includes("ADMIN")
    ) {
      navigate(formulateUrl("dashboard"));
    }
    if (user && courseId) {
      const currentCourseInfo = getCourseInfo(user, courseId);
      setCourseInfo(currentCourseInfo);
      setCourseInfoSessionStorage(currentCourseInfo!);
      document.title = `Manage Assignment Grades | ${
        currentCourseInfo?.courseName || "Course"
      }`;
    }
  }, [courseId, user, navigate, courseInfo?.courseName]);

  useEffect(() => {
    (async () => {
      if (
        debouncedAssignmentId &&
        courseId &&
        user &&
        getCourseRoles(courseId, user.roles).includes("ADMIN")
      ) {
        await getAssignmentGrades(courseId, debouncedAssignmentId);
        setSearchParams((prevSearchParams) => {
          const newSearchParams = new URLSearchParams(prevSearchParams);
          newSearchParams.set("assignmentId", debouncedAssignmentId);
          return newSearchParams.toString();
        });
      } else if (!debouncedAssignmentId) {
        setAssignmentInfo(null);
      }
    })();
  }, [debouncedAssignmentId, courseId, user, setSearchParams]);

  const downloadGradesCsv = () => {
    if (!assignmentInfo) {
      showAlert("Assignment not found.", "info");
      return;
    }
    const header = `"netid","score","comments"\n`;
    const entries = assignmentInfo.grades
      .map((x) => `"${x.netId}","${x.score}","${x.comments || ""}"`)
      .join("\n");
    downloadText(`${debouncedAssignmentId}_grades.csv`, header + entries);
  };

  const findHeaderKey = (
    desiredHeaders: string[],
    actualHeaders: string[],
  ): string | undefined => {
    const lowerActualHeaders = actualHeaders.map((h) => h.toLowerCase().trim());
    for (const desired of desiredHeaders) {
      const lowerDesired = desired.toLowerCase();
      const index = lowerActualHeaders.indexOf(lowerDesired);
      if (index !== -1) {
        return actualHeaders[index];
      }
    }
    return undefined;
  };

  const handleCsvFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!isAdmin()) return;
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

    setIsParsingCsv(true);
    showAlert("Processing CSV file...", "info", 3000);

    try {
      const fileContent = await file.text();
      const lines = fileContent.split(/\r\n|\n/);
      const linesWithCommas = lines.filter((line) => line.includes(","));

      if (linesWithCommas.length === 0) {
        throw new Error(
          "No data lines with commas found. The file might be empty or not comma-separated.",
        );
      }
      const preprocessedCsvString = linesWithCommas.join("\n");

      Papa.parse<CsvGradeRowInput>(preprocessedCsvString, {
        header: true,
        skipEmptyLines: "greedy",
        dynamicTyping: false,
        complete: (results: ParseResult<CsvGradeRowInput>) => {
          try {
            if (results.errors && results.errors.length > 0) {
              const errorMessages = results.errors
                .map(
                  (err) =>
                    `${err.message} (Row: ${err.row === undefined ? "N/A" : err.row + 2})`,
                )
                .join("; ");
              throw new Error(
                `Issues found during CSV parsing: ${errorMessages}`,
              );
            }

            const headers = results.meta.fields as string[] | undefined;
            if (!headers || headers.length === 0) {
              throw new Error("CSV has no headers or is empty.");
            }

            const netIdHeader = findHeaderKey(
              ["netid", "net id", "username"],
              headers,
            );
            const scoreHeader = findHeaderKey(
              ["score", "grade", "points"],
              headers,
            );
            const commentsHeader = findHeaderKey(
              ["comments", "comment", "feedback"],
              headers,
            );

            if (!netIdHeader || !scoreHeader) {
              const missing: string[] = [];
              if (!netIdHeader)
                missing.push("'NetID' (or similar like 'Net Id', 'Username')");
              if (!scoreHeader)
                missing.push("'Score' (or similar like 'Grade', 'Points')");
              throw new Error(
                `CSV header must include columns for: ${missing.join(" and ")}.`,
              );
            }

            const gradeEntries: GradeEntry[] = [];
            const seenNetIds = new Set<string>();

            for (const row of results.data) {
              // Check if row is essentially empty
              if (Object.values(row).every((val) => String(val).trim() === ""))
                continue;

              const netId = String(row[netIdHeader] || "").trim();
              const scoreStr = String(row[scoreHeader] || "").trim();
              const comments = commentsHeader
                ? String(row[commentsHeader] || "").trim()
                : undefined;

              if (!netId) {
                showAlert(
                  `Skipping row: NetID is missing. Data: ${JSON.stringify(row)}`,
                  "warning",
                );
                continue;
              }
              if (!scoreStr) {
                showAlert(
                  `Skipping row for NetID ${netId}: Score is missing.`,
                  "warning",
                );
                continue;
              }

              const score = parseFloat(scoreStr);
              if (isNaN(score)) {
                showAlert(
                  `Skipping row for NetID ${netId}: Score "${scoreStr}" is not a valid number.`,
                  "warning",
                );
                continue;
              }

              if (seenNetIds.has(netId)) {
                showAlert(
                  `Duplicate NetID "${netId}" found in CSV. Using the first encountered entry.`,
                  "warning",
                );
                continue;
              }

              gradeEntries.push({ netId, score, comments });
              seenNetIds.add(netId);
            }

            if (gradeEntries.length > 0) {
              setParsedCsvData(gradeEntries);
              setShowCsvPreviewModal(true);
            } else {
              showAlert(
                "No valid grade entries found in the CSV. Check column headers and data.",
                "warning",
              );
            }
          } catch (parseProcessError) {
            showAlert(
              `Error processing CSV data: ${(parseProcessError as Error).message}`,
              "danger",
            );
          } finally {
            setIsParsingCsv(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }
        },
        error: (error: any) => {
          showAlert(`Failed to parse CSV file: ${error.message}`, "danger");
          setIsParsingCsv(false);
          if (fileInputRef.current) fileInputRef.current.value = "";
        },
      });
    } catch (fileReadError) {
      showAlert(
        `Failed to read or preprocess CSV file: ${(fileReadError as Error).message}`,
        "danger",
      );
      setIsParsingCsv(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const isAdmin = () => {
    return (
      user && courseId && getCourseRoles(courseId, user.roles).includes("ADMIN")
    );
  };

  async function uploadAssignmentGradesAPI(
    courseIdStr: string,
    assignmentIdStr: string,
    grades: GradeEntry[],
  ): Promise<void> {
    const response = await fetch(
      formulateUrl(
        `api/v1/courses/${courseIdStr}/assignment/${assignmentIdStr}/grades`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(grades),
      },
    );
    if (!response.ok) {
      let errorMsg = `Failed to upload grades. Status: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMsg = errorData.message || errorData.detail || errorMsg;
      } catch (e) {}
      throw new Error(errorMsg);
    }
    if (response.status === 201) {
      return;
    }
  }

  const handleConfirmCsvUpload = async () => {
    if (!courseId || !debouncedAssignmentId || parsedCsvData.length === 0) {
      showAlert("No data to upload or course/assignment ID missing.", "danger");
      return;
    }
    setIsUploadingGrades(true);
    try {
      await uploadAssignmentGradesAPI(
        courseId,
        debouncedAssignmentId,
        parsedCsvData,
      );
      showAlert("Grades uploaded successfully!", "success");
      setShowCsvPreviewModal(false);
      setParsedCsvData([]);
      // Refresh grades view
      await getAssignmentGrades(courseId, debouncedAssignmentId);
    } catch (error) {
      showAlert(`Upload failed: ${(error as Error).message}`, "danger");
    } finally {
      setIsUploadingGrades(false);
    }
  };

  if (!courseInfo && user) {
    return <LoadingScreen message="Loading course data..." />;
  }
  if (!user) {
    return <LoadingScreen message="Loading user data..." />;
  }

  return (
    <>
      <AppNavbar
        title={courseInfo?.courseName}
        breadcrumb={{
          items: [
            {
              label: "Course Home",
              href: formulateUrl(`dashboard/${courseId}`),
            },
            {
              label: "Manage Assignment Grades",
              href: formulateUrl(`dashboard/${courseId}/assignmentGrades`),
            },
            ...(assignmentInfo && assignmentInfo.assignmentName
              ? [{ label: assignmentInfo.assignmentName }]
              : debouncedAssignmentId && !isLoading && !assignmentInfo
                ? [{ label: `Grades for ${debouncedAssignmentId}` }]
                : []),
          ],
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Container className="p-3 flex-grow-1">
          <Row className="mb-3">
            <Col xs={12} md={8} lg={6}>
              <h2>Manage Assignment Grades</h2>
              <p className="text-muted">
                To manage individual user grades,{" "}
                <a href={formulateUrl(`dashboard/${courseId}/studentInfo`)}>
                  click here
                </a>
                .
              </p>
              <Form.Group controlId="assignmentIdInput">
                <InputGroup>
                  <Form.Control
                    type="text"
                    placeholder="Assignment ID (e.g., extreme_edge_cases)"
                    value={inputAssignmentId}
                    onChange={(e) =>
                      setInputAssignmentId(e.target.value.replaceAll(" ", ""))
                    }
                  />
                  {isLoading && (
                    <InputGroup.Text>
                      <Spinner animation="border" size="sm" />
                    </InputGroup.Text>
                  )}
                </InputGroup>
              </Form.Group>
            </Col>
          </Row>

          {!isLoading && !assignmentInfo && debouncedAssignmentId && (
            <Alert variant="info" className="text-center">
              Assignment "{debouncedAssignmentId}" does not exist.
              <Button
                onClick={() => setManualAssignmentModal(true)}
                className="ms-3"
                size="sm"
                variant="outline-primary"
              >
                Create Assignment Manually
              </Button>
            </Alert>
          )}

          {assignmentInfo && (
            <>
              <div className="d-flex justify-content-between align-items-center mb-2">
                <h2>
                  Grades for: <code>{assignmentInfo.assignmentName}</code>
                </h2>
                <ButtonGroup>
                  <Button
                    onClick={downloadGradesCsv}
                    disabled={!assignmentInfo}
                    variant="outline-secondary"
                  >
                    Download CSV
                  </Button>
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isParsingCsv || isUploadingGrades}
                    variant="primary"
                  >
                    {isParsingCsv ? (
                      <>
                        <Spinner as="span" size="sm" animation="border" />{" "}
                        Parsing...
                      </>
                    ) : (
                      "Upload Grades CSV"
                    )}
                  </Button>
                </ButtonGroup>
              </div>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleCsvFileSelect}
                accept=".csv, text/csv, application/vnd.ms-excel"
                style={{ display: "none" }}
                disabled={isParsingCsv || isUploadingGrades}
              />
              <p className="text-muted small">
                All timestamps shown in your local timezone ({getTimeZoneName()}
                ). Uploaded CSV should contain 'netid', 'score', and optionally
                'comments' columns.
              </p>
              {assignmentInfo.grades.length > 0 ? (
                <Table striped bordered hover responsive size="sm">
                  <thead>
                    <tr>
                      <th>NetID</th>
                      <th>Score</th>
                      <th>Comments</th>
                      <th>Last Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignmentInfo.grades.map((grade) => (
                      <tr key={grade.netId}>
                        <td>{grade.netId}</td>
                        <td>{grade.score}</td>
                        <td>
                          <p
                            className="text-wrap mb-0"
                            style={{
                              maxWidth: "300px",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {grade.comments || (
                              <span className="text-muted fst-italic">
                                No comments
                              </span>
                            )}
                          </p>
                        </td>
                        <td>
                          {!grade.updatedAt && (
                            <p className="text-muted mb-0 fst-italic">Never</p>
                          )}
                          {grade.updatedAt &&
                            moment(grade.updatedAt).format(
                              dateTimeFormatString,
                            )}
                          {grade.updatedAt && (
                            <p className="text-muted small mb-0">
                              ({moment(grade.updatedAt).fromNow()})
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <Alert variant="secondary">
                  No grades have been recorded for this assignment yet.
                </Alert>
              )}
            </>
          )}

          {manualAssignmentModal && (
            <ManualAssignmentModal
              show={manualAssignmentModal}
              initialData={{
                name: debouncedAssignmentId
                  .split("_")
                  .map((x) => capitalizeFirstLetterOnly(x))
                  .join(" "),
                id: debouncedAssignmentId,
                visibility: AssignmentVisibility.DEFAULT,
                category: Category.OTHER,
              }}
              handleClose={() => setManualAssignmentModal(false)}
              handleSubmit={async (data) => {
                console.log(data);
                setManualAssignmentModal(false);
                await fetch(
                  formulateUrl(`api/v1/courses/${courseId}/assignment/manual`),
                  {
                    method: "POST",
                    body: JSON.stringify(data),
                    headers: { "Content-Type": "application/json" },
                  },
                );
                showAlert("Assignment created!", "success");
                if (debouncedAssignmentId && courseId) {
                  await getAssignmentGrades(courseId, debouncedAssignmentId);
                }
              }}
            />
          )}

          <Modal
            show={showCsvPreviewModal}
            onHide={() => !isUploadingGrades && setShowCsvPreviewModal(false)}
            size="lg"
            backdrop="static"
            keyboard={!isUploadingGrades}
          >
            <Modal.Header closeButton={!isUploadingGrades}>
              <Modal.Title>Confirm Grades Upload</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <p>
                You are about to upload <strong>{parsedCsvData.length}</strong>{" "}
                grade {parsedCsvData.length === 1 ? "entry" : "entries"} for
                assignment{" "}
                <code>
                  {assignmentInfo?.assignmentName || debouncedAssignmentId}
                </code>
                .
              </p>
              <p className="text-muted">
                Existing grades for the same NetIDs will be overwritten. New
                NetIDs will be added. Ensure data is correct before proceeding.
              </p>
              {parsedCsvData.length > 0 ? (
                <Table
                  striped
                  bordered
                  hover
                  responsive
                  size="sm"
                  style={{ maxHeight: "400px", overflowY: "auto" }}
                >
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>NetID</th>
                      <th>Score</th>
                      <th>Comments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedCsvData.map((grade, index) => (
                      <tr key={`${grade.netId}-${index}`}>
                        <td>{index + 1}</td>
                        <td>{grade.netId}</td>
                        <td>{grade.score}</td>
                        <td>
                          {grade.comments || (
                            <span className="text-muted fst-italic">N/A</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <Alert variant="warning">No valid grade data to preview.</Alert>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                onClick={() => setShowCsvPreviewModal(false)}
                disabled={isUploadingGrades}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleConfirmCsvUpload}
                disabled={isUploadingGrades || parsedCsvData.length === 0}
              >
                {isUploadingGrades ? (
                  <>
                    <Spinner as="span" size="sm" animation="border" />{" "}
                    Uploading...
                  </>
                ) : (
                  `Confirm Upload`
                )}
              </Button>
            </Modal.Footer>
          </Modal>
        </Container>
      </div>
    </>
  );
}
