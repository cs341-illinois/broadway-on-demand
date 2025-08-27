import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import AppNavbar from "../components/Navbar";
import {
  Container,
  Dropdown,
  Button,
  ButtonGroup,
  Spinner,
  Form,
} from "react-bootstrap"; // Added Button and ButtonGroup
import {
  CheckInAcceptedResponse,
  CourseLabsInfo,
  WeekAtttendanceStaffInfo,
} from "../../types/attendance";
import moment, { Moment } from "moment-timezone";
import { FullRoleEntry, netIdSchema } from "../../types/index";

export async function getCourseLabsInfo(
  courseId: string,
): Promise<CourseLabsInfo> {
  const response = await fetch(formulateUrl(`api/v1/attendance/${courseId}`));
  if (!response.ok) {
    throw new Error("Failed to get course labs info.");
  }
  return (await response.json()) as CourseLabsInfo;
}

export async function getWeekAttendance(
  courseId: string,
  week: number,
): Promise<WeekAtttendanceStaffInfo> {
  const response = await fetch(
    formulateUrl(`api/v1/attendance/${courseId}/week/${week}/me`),
  );
  if (!response.ok) {
    throw new Error(`Failed to get week ${week} attendance.`);
  }
  return (await response.json()) as WeekAtttendanceStaffInfo;
}

type LabAttendanceContentProps = {
  courseLabsInfoResource: Resource<CourseLabsInfo>;
  courseInfo: FullRoleEntry;
};

function LabAttendanceContent({
  courseLabsInfoResource,
  courseInfo,
}: LabAttendanceContentProps): JSX.Element {
  const { courseId } = courseInfo;
  const [searchParams, setSearchParams] = useSearchParams();
  const [inputIdValue, setInputIdValue] = useState<string>("");
  const uinNetidInput = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (
      loading === false &&
      submitting === false &&
      uinNetidInput != null &&
      uinNetidInput.current != null
    ) {
      uinNetidInput.current.focus();
    }
  }, [loading, submitting]);

  const { courseCutoff, courseTimezone, firstLabDate } =
    courseLabsInfoResource.read();
  const localizedFirstLabDate = moment(firstLabDate).tz(courseTimezone);
  const localizedCutoff = moment(courseCutoff).tz(courseTimezone);

  let numWeeks = 0;
  if (
    localizedCutoff.isValid() &&
    localizedFirstLabDate.isValid() &&
    localizedCutoff.isSameOrAfter(localizedFirstLabDate, "week")
  ) {
    numWeeks = localizedCutoff.week() - localizedFirstLabDate.week();
  } else if (
    localizedCutoff.isValid() &&
    localizedFirstLabDate.isValid() &&
    localizedCutoff.year() > localizedFirstLabDate.year()
  ) {
    numWeeks = localizedCutoff.diff(localizedFirstLabDate, "weeks");
  }

  const firstStartOfWeek = localizedFirstLabDate.clone().startOf("week");
  const firstEndOfWeek = localizedFirstLabDate.clone().endOf("week");
  let attendancePeriods: Record<number, { start: Moment; end: Moment }> = {};
  const now = moment().tz(courseTimezone);
  let initialAttendancePeriod = numWeeks;

  if (numWeeks < 0) numWeeks = 0;

  for (let i = 0; i <= numWeeks; i++) {
    attendancePeriods[i] = {
      start:
        i === 0
          ? localizedFirstLabDate
          : firstStartOfWeek.clone().add({ week: i }),
      end:
        i === numWeeks
          ? localizedCutoff
          : firstEndOfWeek.clone().add({ week: i }),
    };
    if (attendancePeriods[i].start <= now && attendancePeriods[i].end >= now) {
      initialAttendancePeriod = i;
    }
  }
  if (Object.keys(attendancePeriods).length > 0) {
    if (now.isAfter(attendancePeriods[numWeeks].end)) {
      initialAttendancePeriod = numWeeks;
    } else if (now.isBefore(attendancePeriods[0].start)) {
      initialAttendancePeriod = 0;
    }
  } else {
    initialAttendancePeriod = 0;
    if (Object.keys(attendancePeriods).length === 0) {
      attendancePeriods[0] = { start: firstStartOfWeek, end: firstEndOfWeek };
    }
  }

  const [selectedPeriod, setSelectedPeriod] = useState<number>(
    initialAttendancePeriod,
  );
  const [selectedPeriodGrades, setSelectedPeriodGrades] =
    useState<WeekAtttendanceStaffInfo | null>(null);

  const { showAlert } = useAlert();

  const periodKeys = Object.keys(attendancePeriods);
  const numberOfPeriods = periodKeys.length;

  const handlePrevious = () => {
    setSelectedPeriod((prevPeriod) => Math.max(0, prevPeriod - 1));
  };

  const handleNext = () => {
    setSelectedPeriod((prevPeriod) =>
      Math.min(numberOfPeriods - 1, prevPeriod + 1),
    );
  };

  const sendCheckInRequest = async (
    type: "uin" | "netId",
    value: string,
  ): Promise<CheckInAcceptedResponse> => {
    if (
      type === "netId" &&
      selectedPeriodGrades &&
      selectedPeriodGrades.filter((x) => x.netId === value).length > 0
    ) {
      throw new Error("Student has already been checked in.");
    }
    const response = await fetch(
      formulateUrl(
        `api/v1/attendance/${courseId}/week/${selectedPeriod}/checkIn`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, value }),
      },
    );
    if (!response.ok) {
      let message = "Failed to check in student.";
      try {
        message = (await response.json()).message;
      } catch (e) {}
      throw new Error(message);
    }
    return (await response.json()) as CheckInAcceptedResponse;
  };

  const submitAttendance = async (): Promise<void> => {
    const response = await fetch(
      formulateUrl(
        `api/v1/attendance/${courseId}/week/${selectedPeriod}/submit`,
      ),
      {
        method: "POST",
      },
    );
    if (!response.ok) {
      let message = "Failed to submit attendance data.";
      try {
        message = (await response.json()).message;
      } catch (e) {}
      throw new Error(message);
    }
  };

  useEffect(() => {
    const f = async () => {
      const week = searchParams.get("week");
      if (week) {
        setSelectedPeriod(parseInt(week, 10));
        setSelectedPeriodGrades(
          await getWeekAttendance(courseId, parseInt(week, 10)),
        );
      }
    };
    f();
  }, []);

  const breadcrumb = {
    items: [
      {
        label: "Course Home",
        href: formulateUrl(`dashboard/${courseId}`),
      },
      { label: "Take Attendance" },
    ],
  };

  useEffect(() => {
    setSearchParams((prevSearchParams) => {
      const newSearchParams = new URLSearchParams(prevSearchParams);
      newSearchParams.set("week", selectedPeriod.toString());
      return newSearchParams.toString();
    });
    const f = async () => {
      setSelectedPeriodGrades(null);
      setSelectedPeriodGrades(
        await getWeekAttendance(courseId, selectedPeriod),
      );
    };
    f();
  }, [selectedPeriod]);

  if (numberOfPeriods === 0) {
    return (
      <>
        <AppNavbar title={courseInfo.courseName} breadcrumb={breadcrumb} />
        <Container>
          <h2>Lab Attendance</h2>
          <p>No attendance periods available.</p>
        </Container>
      </>
    );
  }
  const currentPeriodData = attendancePeriods[selectedPeriod];
  if (!currentPeriodData) {
    if (numberOfPeriods > 0 && attendancePeriods[initialAttendancePeriod]) {
      setSelectedPeriod(initialAttendancePeriod);
    } else if (numberOfPeriods > 0 && attendancePeriods[0]) {
      setSelectedPeriod(0);
    } else {
      showAlert("Could not find attendance data.", "danger");
      return (
        <>
          <AppNavbar title={courseInfo.courseName} breadcrumb={breadcrumb} />
          <Container>
            <h2>Lab Attendance</h2>
          </Container>
        </>
      );
    }
    showAlert("Could not find attendance data.", "danger");
    return (
      <>
        <AppNavbar title={courseInfo.courseName} breadcrumb={breadcrumb} />
        <Container>
          <h2>Lab Attendance</h2>
        </Container>
      </>
    );
  }

  const onCheckInFormSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setLoading(true);
    // check if UIN or NetID
    const isUIN =
      inputIdValue === parseInt(inputIdValue).toString() &&
      inputIdValue.length === 9;
    const isNetId = netIdSchema.safeParse(inputIdValue).success;
    if (!((isUIN || isNetId) && !(isUIN && isNetId))) {
      // invalid
      showAlert(`Invalid entry "${inputIdValue}"`, "danger");
      setInputIdValue("");
      setLoading(false);
      return;
    }
    try {
      const response = await sendCheckInRequest(
        isUIN ? "uin" : "netId",
        inputIdValue,
      );
      if (!response.modified) {
        showAlert(
          "User was already checked in for this week, no changes made.",
          "warning",
        );
      } else {
        setSelectedPeriodGrades((prev) => {
          return [
            { name: response.name, netId: response.netId, submitted: false },
            ...(prev || []),
          ];
        });
      }
    } catch (e: any) {
      showAlert(e.message, "danger");
      throw e;
    } finally {
      setInputIdValue("");
      setLoading(false);
    }
  };

  const onAttendanceSubmit = async () => {
    const pendingGrades = selectedPeriodGrades?.filter(
      (x) => !x.submitted,
    ).length;
    if (pendingGrades === 0) {
      return;
    }
    setSubmitting(true);
    try {
      await submitAttendance();
      setSelectedPeriodGrades((prev) => {
        return (prev || []).map((x) => ({ ...x, submitted: true }));
      });
      showAlert("Attendance submitted!", "success");
    } catch (e: any) {
      showAlert(e.message, "danger");
      throw e;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <AppNavbar title={courseInfo.courseName} breadcrumb={breadcrumb} />
      <Container>
        <h2>Lab Attendance</h2>
        <p className="text-muted">
          All timestamps shown in the course timezone ({courseTimezone}).
        </p>
        <ButtonGroup style={{ marginBottom: "1rem" }}>
          <Button
            variant="primary"
            onClick={handlePrevious}
            disabled={selectedPeriod === 0 || numberOfPeriods === 0}
            aria-label="Previous week"
          >
            &lt; Previous
          </Button>

          <Dropdown as={ButtonGroup}>
            <Dropdown.Toggle variant="primary" id="week-dropdown">
              Week {selectedPeriod + 1} (
              {attendancePeriods[selectedPeriod].start.format("MM/DD")} -{" "}
              {attendancePeriods[selectedPeriod].end.format("MM/DD")})
            </Dropdown.Toggle>

            <Dropdown.Menu>
              {periodKeys.map((key) => {
                const index = parseInt(key, 10);
                if (!attendancePeriods[index]) return null;
                return (
                  <Dropdown.Item
                    key={key}
                    onClick={() => setSelectedPeriod(index)}
                    active={selectedPeriod === index}
                  >
                    Week {index + 1} (
                    {attendancePeriods[index].start.format("MM/DD")} -{" "}
                    {attendancePeriods[index].end.format("MM/DD")})
                  </Dropdown.Item>
                );
              })}
            </Dropdown.Menu>
          </Dropdown>

          <Button
            variant="primary"
            onClick={handleNext}
            disabled={
              selectedPeriod === numberOfPeriods - 1 || numberOfPeriods === 0
            }
            aria-label="Next week"
          >
            Next &gt;
          </Button>
        </ButtonGroup>
        <div>
          {selectedPeriodGrades === null && <Spinner />}
          <Form className="d-flex mt-4" onSubmit={onCheckInFormSubmit}>
            <Form.Control
              type="text"
              className="me-3 border border-primary"
              aria-describedby="UIN or NetID"
              placeholder="Enter UIN/NetID or swipe iCard"
              value={inputIdValue}
              onChange={(e) => {
                setInputIdValue(e.target.value.trim());
              }}
              autoComplete="off"
              disabled={loading || submitting}
              ref={uinNetidInput}
            />
            <Button
              type="submit"
              variant="primary"
              disabled={loading || submitting}
            >
              Check In
            </Button>
          </Form>
          <hr />
          {selectedPeriodGrades && (
            <>
              {selectedPeriodGrades.length === 0 && (
                <p className="text-muted">No attendance records found.</p>
              )}
              {selectedPeriodGrades.length > 0 && (
                <div style={{ maxHeight: "20vh", overflowY: "auto" }}>
                  <ul className="list-group">
                    {selectedPeriodGrades.map((x) => (
                      <li
                        key={x.netId}
                        className={`list-group-item ${x.submitted ? "list-group-item-dark" : ""} d-flex justify-content-between align-items-center`}
                      >
                        {x.name}
                        {x.submitted && (
                          <span className="fst-italic text-muted">
                            submitted
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <hr />
              <h3>Session Complete?</h3>
              <p className="text-muted">
                Click the button below to upload attendance grades.
              </p>
              <Button
                variant="success"
                disabled={
                  loading ||
                  submitting ||
                  selectedPeriodGrades?.filter((x) => !x.submitted).length === 0
                }
                onClick={() => {
                  onAttendanceSubmit();
                }}
              >
                Submit Lab Attendance
              </Button>
            </>
          )}
        </div>
      </Container>
    </>
  );
}

export default function LabAttendancePage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const [courseInfo, setCourseInfo] = useState<FullRoleEntry | null>(null);

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  const isStaffOrAdmin = useMemo(
    () => courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF),
    [courseRoles],
  );

  useEffect(() => {
    if (!user) return; // Wait for user data
    // If user data is present, then check permissions
    if (user && (!courseId || !isStaffOrAdmin)) {
      showAlert(
        "You do not have permission to view this page or the course ID is invalid.",
        "danger",
      );
      navigate(formulateUrl("dashboard"));
    }
    const courseInfoMeta = getCourseInfo(user, courseId)!;
    setCourseInfo(getCourseInfo(user, courseId));
    setCourseInfoSessionStorage(getCourseInfo(user, courseId)!);
    document.title = `Student Info | ${courseInfoMeta?.courseName}`;
  }, [courseId, user, isStaffOrAdmin, navigate, showAlert]);

  const courseLabsInfoResource = useMemo<Resource<CourseLabsInfo>>(() => {
    if (!user || !courseId || !isStaffOrAdmin) {
      // Ensure user is loaded
      return createResource<CourseLabsInfo>(() =>
        Promise.reject(
          new Error(
            "Access denied or prerequisites not met for loading lab info.",
          ),
        ),
      );
    }
    return createResource<CourseLabsInfo>(() => getCourseLabsInfo(courseId));
  }, [courseId, isStaffOrAdmin, user]);

  // This check might be too early if user is not yet loaded.
  // The useEffect handles navigation once user data is available.
  // Consider showing LoadingScreen until user and permissions are confirmed.
  if (!user || !courseInfo) {
    return <LoadingScreen message="Authenticating..." />;
  }
  if (!isStaffOrAdmin && user) {
    // If user is loaded but not authorized
    // The useEffect will navigate away, but this can prevent rendering child components prematurely.
    return <LoadingScreen message="Checking permissions..." />;
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <LabAttendanceContent
            courseLabsInfoResource={courseLabsInfoResource}
            courseInfo={courseInfo}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
