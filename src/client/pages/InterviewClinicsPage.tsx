import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Container,
  Form,
  Row,
  Spinner,
  Table,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";
import moment from "moment-timezone";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import ConfirmationModal from "../components/ConfirmationModal";
import { LoadingScreen } from "../components/Loading";
import { Role } from "../enums";
import {
  ClinicCalendarStatusValue,
  ClinicEntry,
  ClinicPerson,
  ClinicsListResponse,
  OutlookStatusResponse,
  StaffClinicViewResponse,
  StudentClinicViewResponse,
} from "../../types/clinics";

type ShowAlert = ReturnType<typeof useAlert>["showAlert"];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const { headers, ...rest } = init ?? {};
  // Only send a JSON content-type when there is a body - Fastify rejects an
  // empty body with a JSON content-type (FST_ERR_CTP_EMPTY_JSON_BODY).
  const response = await fetch(formulateUrl(url), {
    ...rest,
    headers: {
      ...(rest.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${response.status}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const SLOT_TIMES = Array.from({ length: 48 }, (_, i) =>
  moment.utc(0).add(i * 30, "minutes").format("HH:mm"),
);

function personLabel(p: ClinicPerson) {
  return p.name ? `${p.name} (${p.netId})` : p.netId;
}

function groupByDay<T extends { startAt: string }>(items: T[], tz: string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const day = moment(item.startAt).tz(tz).format("dddd, MMMM D");
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return [...groups.entries()];
}

function CalendarBadge({
  status,
  error,
}: {
  status: ClinicCalendarStatusValue;
  error?: string | null;
}) {
  const variant = {
    PENDING: "secondary",
    CREATED: "success",
    FAILED: "danger",
    CANCELLED: "secondary",
  }[status];
  const label = {
    PENDING: "Invite pending",
    CREATED: "Invite sent",
    FAILED: "Invite failed",
    CANCELLED: "Cancelled",
  }[status];
  return (
    <Badge bg={variant} title={error ?? undefined}>
      {label}
    </Badge>
  );
}

function reportCalendarResult(
  showAlert: ShowAlert,
  result: { calendarStatus: ClinicCalendarStatusValue; calendarError: string | null },
  successMessage: string,
) {
  if (result.calendarStatus === "FAILED") {
    showAlert(
      `${successMessage}, but the Outlook update failed: ${result.calendarError}. Course staff can retry it.`,
      "warning",
    );
  } else {
    showAlert(successMessage, "success");
  }
}

// ---------------------------------------------------------------------------
// Admin: create clinic / manage room bookings
// ---------------------------------------------------------------------------

function CreateClinicCard({
  courseId,
  onCreated,
  showAlert,
}: {
  courseId: string;
  onCreated: (clinic: ClinicEntry) => void;
  showAlert: ShowAlert;
}) {
  const [projectKeys, setProjectKeys] = useState<string[]>([]);
  const [projectKey, setProjectKey] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchJson<{ projectKey: string }[]>(
      `api/v1/projectRepos/${courseId}/projects`,
    )
      .then((projects) => {
        setProjectKeys(projects.map((p) => p.projectKey));
        if (projects.length > 0) setProjectKey(projects[0].projectKey);
      })
      .catch((e) => showAlert(e.message, "danger"));
  }, [courseId, showAlert]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const clinic = await fetchJson<ClinicEntry>(`api/v1/clinics/${courseId}`, {
        method: "POST",
        body: JSON.stringify({
          projectKey,
          title,
          description: description || null,
        }),
      });
      setTitle("");
      setDescription("");
      onCreated(clinic);
      showAlert("Clinic created.", "success");
    } catch (err) {
      showAlert((err as Error).message, "danger");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="mb-3">
      <Card.Header as="h5">New Interview Clinic</Card.Header>
      <Card.Body>
        <Form onSubmit={onSubmit}>
          <Row className="g-2">
            <Col md={3}>
              <Form.Label>Project</Form.Label>
              <Form.Select
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                required
              >
                {projectKeys.map((pk) => (
                  <option key={pk} value={pk}>
                    {pk}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col md={4}>
              <Form.Label>Title</Form.Label>
              <Form.Control
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Malloc Interview Clinic"
                required
              />
            </Col>
            <Col md={5}>
              <Form.Label>Description (included in the invite)</Form.Label>
              <Form.Control
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Col>
          </Row>
          <Button
            type="submit"
            className="mt-3"
            disabled={isSaving || !projectKey}
          >
            {isSaving && <Spinner size="sm" animation="border" className="me-1" />}
            Create Clinic
          </Button>
        </Form>
      </Card.Body>
    </Card>
  );
}

function AdminClinicCard({
  courseId,
  timezone,
  view,
  onChanged,
  showAlert,
}: {
  courseId: string;
  timezone: string;
  view: StaffClinicViewResponse;
  onChanged: () => void;
  showAlert: ShowAlert;
}) {
  const { clinic, blocks } = view;
  const [room, setRoom] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("13:00");
  const [endTime, setEndTime] = useState("15:00");
  const [signupOpensAt, setSignupOpensAt] = useState(
    clinic.signupOpensAt
      ? moment(clinic.signupOpensAt).tz(timezone).format("YYYY-MM-DDTHH:mm")
      : "",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    setSignupOpensAt(
      clinic.signupOpensAt
        ? moment(clinic.signupOpensAt).tz(timezone).format("YYYY-MM-DDTHH:mm")
        : "",
    );
  }, [clinic.signupOpensAt, timezone]);

  const run = async (fn: () => Promise<void>, success: string) => {
    setIsSaving(true);
    try {
      await fn();
      showAlert(success, "success");
      onChanged();
    } catch (err) {
      showAlert((err as Error).message, "danger");
    } finally {
      setIsSaving(false);
    }
  };

  const addBlock = (e: React.FormEvent) => {
    e.preventDefault();
    const toIso = (time: string) =>
      moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", timezone).toISOString();
    void run(
      () =>
        fetchJson(`api/v1/clinics/${courseId}/${clinic.id}/blocks`, {
          method: "POST",
          body: JSON.stringify({
            room,
            startAt: toIso(startTime),
            endAt: toIso(endTime),
          }),
        }),
      "Room booking added.",
    );
  };

  const patchClinic = (body: object, success: string) =>
    run(
      () =>
        fetchJson(`api/v1/clinics/${courseId}/${clinic.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
      success,
    );

  return (
    <Card className="mb-3">
      <Card.Header as="h5">Instructor: Room Bookings &amp; Settings</Card.Header>
      <Card.Body>
        <Form onSubmit={addBlock}>
          <Row className="g-2 align-items-end">
            <Col md={4}>
              <Form.Label>Room</Form.Label>
              <Form.Control
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                placeholder="e.g. Siebel 0216"
                required
              />
            </Col>
            <Col md={3}>
              <Form.Label>Date</Form.Label>
              <Form.Control
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </Col>
            <Col md={2}>
              <Form.Label>Start</Form.Label>
              <Form.Select
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              >
                {SLOT_TIMES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Form.Select>
            </Col>
            <Col md={2}>
              <Form.Label>End</Form.Label>
              <Form.Select
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              >
                {SLOT_TIMES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Form.Select>
            </Col>
            <Col md={1}>
              <Button type="submit" disabled={isSaving} className="w-100">
                Add
              </Button>
            </Col>
          </Row>
          <Form.Text muted>
            Times are in the course timezone ({timezone}). Each booking is split
            into 30-minute slots.
          </Form.Text>
        </Form>

        {blocks.length > 0 && (
          <Table size="sm" className="mt-3" responsive>
            <thead>
              <tr>
                <th>Room</th>
                <th>Date</th>
                <th>Time</th>
                <th>Added by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id}>
                  <td>{b.room}</td>
                  <td>{moment(b.startAt).tz(timezone).format("ddd MM/DD/YYYY")}</td>
                  <td>
                    {moment(b.startAt).tz(timezone).format("h:mm A")} –{" "}
                    {moment(b.endAt).tz(timezone).format("h:mm A")}
                  </td>
                  <td>{b.createdBy}</td>
                  <td className="text-end">
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={() => setDeleteTarget(b.id)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <hr />
        <Row className="g-2 align-items-end">
          <Col md={5}>
            <Form.Label>Student signups open at (blank = immediately)</Form.Label>
            <Form.Control
              type="datetime-local"
              value={signupOpensAt}
              onChange={(e) => setSignupOpensAt(e.target.value)}
            />
          </Col>
          <Col md="auto">
            <Button
              variant="outline-primary"
              disabled={isSaving}
              onClick={() =>
                void patchClinic(
                  {
                    signupOpensAt: signupOpensAt
                      ? moment
                          .tz(signupOpensAt, "YYYY-MM-DDTHH:mm", timezone)
                          .toISOString()
                      : null,
                  },
                  "Signup time saved.",
                )
              }
            >
              Save
            </Button>
          </Col>
          <Col className="text-end">
            <Button
              variant={clinic.archivedAt ? "outline-success" : "outline-secondary"}
              disabled={isSaving}
              onClick={() =>
                void patchClinic(
                  { archived: !clinic.archivedAt },
                  clinic.archivedAt ? "Clinic restored." : "Clinic archived.",
                )
              }
            >
              {clinic.archivedAt ? "Unarchive Clinic" : "Archive Clinic"}
            </Button>
          </Col>
        </Row>
      </Card.Body>
      <ConfirmationModal
        show={deleteTarget !== null}
        title="Delete room booking?"
        message="All of its slots will be removed. This is only allowed if no team has booked one of them."
        confirmText="Delete"
        isProcessing={isSaving}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const id = deleteTarget!;
          setDeleteTarget(null);
          void run(
            () =>
              fetchJson(`api/v1/clinics/${courseId}/${clinic.id}/blocks/${id}`, {
                method: "DELETE",
              }),
            "Room booking deleted.",
          );
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Staff (CAs): claim slots, manage bookings
// ---------------------------------------------------------------------------

function OutlookBanner({
  courseId,
  status,
}: {
  courseId: string;
  status: OutlookStatusResponse | null;
}) {
  if (!status) return null;
  const connectUrl = formulateUrl(
    `login/outlook?courseId=${encodeURIComponent(courseId)}`,
  );
  if (!status.configured) {
    return (
      <Alert variant="warning">
        Outlook integration is not configured on this server, so calendar
        invites cannot be sent.
      </Alert>
    );
  }
  if (status.connected) {
    return (
      <Alert variant="success" className="d-flex align-items-center">
        <span className="me-auto">
          Your Outlook calendar is connected. Clinic invites will be sent from
          your calendar.
        </span>
        <Button size="sm" variant="outline-success" href={connectUrl}>
          Reconnect
        </Button>
      </Alert>
    );
  }
  return (
    <Alert variant="info" className="d-flex align-items-center">
      <span className="me-auto">
        {status.lastError ??
          "Connect your Outlook calendar before claiming slots. Booked interviews are added to your calendar and students are invited automatically."}
      </span>
      <Button size="sm" href={connectUrl}>
        Connect Outlook
      </Button>
    </Alert>
  );
}

function StaffSlotsCard({
  courseId,
  timezone,
  view,
  viewerNetId,
  isAdmin,
  canClaim,
  onChanged,
  showAlert,
}: {
  courseId: string;
  timezone: string;
  view: StaffClinicViewResponse;
  viewerNetId: string;
  isAdmin: boolean;
  canClaim: boolean;
  onChanged: () => void;
  showAlert: ShowAlert;
}) {
  const { clinic, slots, cancelledWithCalendarErrors } = view;
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const base = `api/v1/clinics/${courseId}/${clinic.id}`;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusySlot(key);
    try {
      await fn();
      onChanged();
    } catch (err) {
      showAlert((err as Error).message, "danger");
    } finally {
      setBusySlot(null);
    }
  };

  const visibleSlots = slots.filter(
    (s) =>
      (showPast || moment(s.endAt).isAfter(moment())) &&
      (!onlyMine || s.ca?.netId === viewerNetId),
  );
  const claimedCount = slots.filter((s) => s.ca?.netId === viewerNetId).length;
  const bookedCount = slots.filter((s) => s.booking).length;

  return (
    <Card className="mb-3">
      <Card.Header className="d-flex align-items-center flex-wrap gap-3">
        <h5 className="mb-0 me-auto">Slots</h5>
        <span className="text-muted small">
          {slots.length} slots · {slots.filter((s) => s.ca).length} covered ·{" "}
          {bookedCount} booked · {claimedCount} yours
        </span>
        <Form.Check
          type="switch"
          id="only-mine"
          label="Only my slots"
          checked={onlyMine}
          onChange={(e) => setOnlyMine(e.target.checked)}
        />
        <Form.Check
          type="switch"
          id="show-past"
          label="Show past"
          checked={showPast}
          onChange={(e) => setShowPast(e.target.checked)}
        />
      </Card.Header>
      <Card.Body>
        {visibleSlots.length === 0 && (
          <p className="text-muted mb-0">
            {slots.length === 0
              ? "No rooms have been booked for this clinic yet."
              : "No slots match the current filters."}
          </p>
        )}
        {groupByDay(visibleSlots, timezone).map(([day, daySlots]) => (
          <div key={day} className="mb-3">
            <h6>{day}</h6>
            <Table size="sm" responsive hover>
              <thead>
                <tr>
                  <th style={{ width: "12%" }}>Time</th>
                  <th style={{ width: "15%" }}>Room</th>
                  <th style={{ width: "18%" }}>CA</th>
                  <th>Team</th>
                  <th style={{ width: "22%" }} />
                </tr>
              </thead>
              <tbody>
                {daySlots.map((s) => {
                  const mine = s.ca?.netId === viewerNetId;
                  const past = moment(s.startAt).isBefore(moment());
                  const busy = busySlot === s.id;
                  return (
                    <tr key={s.id} className={mine ? "table-primary" : undefined}>
                      <td>{moment(s.startAt).tz(timezone).format("h:mm A")}</td>
                      <td>{s.room}</td>
                      <td>
                        {s.ca ? personLabel(s.ca) : <span className="text-muted">—</span>}
                      </td>
                      <td>
                        {s.booking ? (
                          <>
                            <b>{s.booking.repoName}</b>{" "}
                            <CalendarBadge
                              status={s.booking.calendarStatus}
                              error={s.booking.calendarError}
                            />
                            <div className="small text-muted">
                              {s.booking.attendees.map(personLabel).join(", ")}
                            </div>
                            {s.booking.calendarError && (
                              <div className="small text-danger">
                                {s.booking.calendarError}
                              </div>
                            )}
                          </>
                        ) : s.ca ? (
                          <span className="text-muted">Open</span>
                        ) : null}
                      </td>
                      <td className="text-end">
                        {busy && <Spinner size="sm" animation="border" className="me-2" />}
                        {!s.ca && !past && (
                          <Button
                            size="sm"
                            disabled={busy || !canClaim}
                            onClick={() =>
                              void act(s.id, () =>
                                fetchJson(`${base}/slots/${s.id}/claim`, {
                                  method: "POST",
                                }),
                              )
                            }
                          >
                            Claim
                          </Button>
                        )}
                        {s.ca && !s.booking && (mine || isAdmin) && !past && (
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            disabled={busy}
                            onClick={() =>
                              void act(s.id, () =>
                                fetchJson(`${base}/slots/${s.id}/claim`, {
                                  method: "DELETE",
                                }),
                              )
                            }
                          >
                            Release
                          </Button>
                        )}
                        {s.booking?.calendarStatus === "FAILED" && (
                          <Button
                            size="sm"
                            variant="outline-warning"
                            className="me-1"
                            disabled={busy}
                            onClick={() =>
                              void act(s.id, async () => {
                                const result = await fetchJson<{
                                  calendarStatus: ClinicCalendarStatusValue;
                                  calendarError: string | null;
                                }>(`${base}/bookings/${s.booking!.id}/retryCalendar`, {
                                  method: "POST",
                                });
                                reportCalendarResult(showAlert, result, "Retried");
                              })
                            }
                          >
                            Retry Invite
                          </Button>
                        )}
                        {s.booking && !past && (
                          <Button
                            size="sm"
                            variant="outline-danger"
                            disabled={busy}
                            onClick={() => setCancelTarget(s.booking!.id)}
                          >
                            Cancel Booking
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        ))}

        {cancelledWithCalendarErrors.length > 0 && (
          <>
            <h6 className="text-danger">
              Cancelled bookings whose Outlook cancellation failed
            </h6>
            <Table size="sm" responsive>
              <tbody>
                {cancelledWithCalendarErrors.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {moment(b.slotStartAt).tz(timezone).format("ddd MM/DD h:mm A")}
                    </td>
                    <td>{b.room}</td>
                    <td>{b.repoName}</td>
                    <td className="small text-danger">{b.calendarError}</td>
                    <td className="text-end">
                      <Button
                        size="sm"
                        variant="outline-warning"
                        disabled={busySlot === b.id}
                        onClick={() =>
                          void act(b.id, async () => {
                            const result = await fetchJson<{
                              calendarStatus: ClinicCalendarStatusValue;
                              calendarError: string | null;
                            }>(`${base}/bookings/${b.id}/retryCalendar`, {
                              method: "POST",
                            });
                            reportCalendarResult(showAlert, result, "Retried");
                          })
                        }
                      >
                        Retry Cancellation
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card.Body>
      <ConfirmationModal
        show={cancelTarget !== null}
        title="Cancel this booking?"
        message="The team will receive an Outlook cancellation and the slot will open up again."
        confirmText="Cancel Booking"
        cancelText="Keep"
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          const id = cancelTarget!;
          setCancelTarget(null);
          void act(id, async () => {
            const result = await fetchJson<{
              calendarStatus: ClinicCalendarStatusValue;
              calendarError: string | null;
            }>(`${base}/bookings/${id}/cancel`, { method: "POST" });
            reportCalendarResult(showAlert, result, "Booking cancelled");
          });
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Students: sign up as a team
// ---------------------------------------------------------------------------

function StudentClinicView({
  courseId,
  timezone,
  view,
  onChanged,
  showAlert,
}: {
  courseId: string;
  timezone: string;
  view: StudentClinicViewResponse;
  onChanged: () => void;
  showAlert: ShowAlert;
}) {
  const { clinic, team, myBooking, slots, signupOpen, cancelCutoffHours } = view;
  const [busy, setBusy] = useState<string | null>(null);
  const [bookTarget, setBookTarget] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);
  const base = `api/v1/clinics/${courseId}/${clinic.id}`;
  const fmt = (iso: string, f: string) => moment(iso).tz(timezone).format(f);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      showAlert((err as Error).message, "danger");
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const target = slots.find((s) => s.id === bookTarget);

  if (!team) {
    return (
      <Alert variant="warning">
        You are not on a team for <b>{clinic.projectKey}</b> yet, so you cannot
        sign up. Contact course staff if you think this is a mistake.
      </Alert>
    );
  }

  return (
    <>
      <Card className="mb-3">
        <Card.Header as="h5">Your Team</Card.Header>
        <Card.Body>
          <p className="mb-1">
            <b>{team.repoName}</b>
          </p>
          <p className="mb-0 text-muted">
            {team.members.map(personLabel).join(", ")}
          </p>
          <p className="small text-muted mt-2 mb-0">
            Any team member can book or cancel for the whole team. Everyone on
            the team receives the Outlook invite.
          </p>
        </Card.Body>
      </Card>

      {myBooking && (
        <Card className="mb-3" border="success">
          <Card.Header as="h5">Your Booking</Card.Header>
          <Card.Body>
            <p className="mb-1">
              <b>{fmt(myBooking.startAt, "dddd, MMMM D")}</b>,{" "}
              {fmt(myBooking.startAt, "h:mm A")} – {fmt(myBooking.endAt, "h:mm A")}
            </p>
            <p className="mb-1">Room: {myBooking.room}</p>
            <p className="mb-2">With: {personLabel(myBooking.ca)}</p>
            <CalendarBadge status={myBooking.calendarStatus} />
            <div className="mt-3">
              <Button
                variant="outline-danger"
                disabled={!myBooking.canCancel || busy !== null}
                onClick={() => setShowCancel(true)}
              >
                Cancel Booking
              </Button>
              {!myBooking.canCancel && (
                <Form.Text className="ms-2" muted>
                  Bookings can only be cancelled more than {cancelCutoffHours}{" "}
                  hours in advance. Please contact course staff.
                </Form.Text>
              )}
            </div>
          </Card.Body>
        </Card>
      )}

      <Card className="mb-3">
        <Card.Header as="h5">Available Slots</Card.Header>
        <Card.Body>
          {!signupOpen && (
            <Alert variant="info">
              Signups open{" "}
              {clinic.signupOpensAt
                ? fmt(clinic.signupOpensAt, "dddd, MMMM D [at] h:mm A")
                : "soon"}
              .
            </Alert>
          )}
          {myBooking && (
            <p className="text-muted">
              Your team already has a slot. Cancel it to pick a different one.
            </p>
          )}
          {slots.length === 0 && (
            <p className="text-muted mb-0">No slots are being offered yet.</p>
          )}
          {groupByDay(slots, timezone).map(([day, daySlots]) => (
            <div key={day} className="mb-3">
              <h6>{day}</h6>
              <Table size="sm" responsive>
                <tbody>
                  {daySlots.map((s) => (
                    <tr key={s.id}>
                      <td style={{ width: "25%" }}>
                        {fmt(s.startAt, "h:mm A")} – {fmt(s.endAt, "h:mm A")}
                      </td>
                      <td>{s.room}</td>
                      <td>{s.ca.name ?? s.ca.netId}</td>
                      <td className="text-end">
                        {s.available ? (
                          <Button
                            size="sm"
                            disabled={!signupOpen || !!myBooking || busy !== null}
                            onClick={() => setBookTarget(s.id)}
                          >
                            Book
                          </Button>
                        ) : (
                          <Badge bg="secondary">Taken</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ))}
        </Card.Body>
      </Card>

      <ConfirmationModal
        show={target !== undefined}
        title="Book this slot?"
        message={
          target && (
            <>
              <p>
                {fmt(target.startAt, "dddd, MMMM D, h:mm A")} in {target.room}{" "}
                with {target.ca.name ?? target.ca.netId}.
              </p>
              <p className="mb-0">
                All members of {team.repoName} will receive an Outlook invite.
                You can cancel up to {cancelCutoffHours} hours beforehand.
              </p>
            </>
          )
        }
        confirmText="Book"
        confirmVariant="primary"
        onCancel={() => setBookTarget(null)}
        onConfirm={() => {
          const id = bookTarget!;
          setBookTarget(null);
          void act(id, async () => {
            const result = await fetchJson<{
              calendarStatus: ClinicCalendarStatusValue;
              calendarError: string | null;
            }>(`${base}/slots/${id}/book`, { method: "POST" });
            reportCalendarResult(showAlert, result, "Slot booked");
          });
        }}
      />
      <ConfirmationModal
        show={showCancel}
        title="Cancel your team's booking?"
        message="Your team will receive an Outlook cancellation and the slot will be released."
        confirmText="Cancel Booking"
        cancelText="Keep"
        onCancel={() => setShowCancel(false)}
        onConfirm={() => {
          setShowCancel(false);
          void act("cancel", async () => {
            const result = await fetchJson<{
              calendarStatus: ClinicCalendarStatusValue;
              calendarError: string | null;
            }>(`${base}/bookings/${myBooking!.id}/cancel`, { method: "POST" });
            reportCalendarResult(showAlert, result, "Booking cancelled");
          });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InterviewClinicsPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);
  const isAdmin = courseRoles.includes(Role.ADMIN);
  const isStaff = isAdmin || courseRoles.includes(Role.STAFF);
  const viewerNetId = user?.email.replace("@illinois.edu", "") ?? "";

  const [list, setList] = useState<ClinicsListResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [staffView, setStaffView] = useState<StaffClinicViewResponse | null>(null);
  const [studentView, setStudentView] =
    useState<StudentClinicViewResponse | null>(null);
  const [outlook, setOutlook] = useState<OutlookStatusResponse | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (!courseId || courseRoles.length === 0) {
      showAlert("You do not have permission to view this page.", "danger");
      navigate(formulateUrl("dashboard"));
      return;
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Interview Clinics | ${courseInfo.courseName}`;
  }, [courseId, user, courseRoles, navigate, showAlert]);

  const loadList = useCallback(async () => {
    try {
      const data = await fetchJson<ClinicsListResponse>(
        `api/v1/clinics/${courseId}`,
      );
      setList(data);
      setSelectedId((current) =>
        data.clinics.some((c) => c.id === current)
          ? current
          : (data.clinics.find((c) => !c.archivedAt)?.id ??
            data.clinics[0]?.id ??
            ""),
      );
    } catch (err) {
      showAlert((err as Error).message, "danger");
    }
  }, [courseId, showAlert]);

  const loadView = useCallback(async () => {
    if (!selectedId) {
      setStaffView(null);
      setStudentView(null);
      return;
    }
    setViewLoading(true);
    try {
      if (isStaff) {
        const [view, status] = await Promise.all([
          fetchJson<StaffClinicViewResponse>(
            `api/v1/clinics/${courseId}/${selectedId}/staff`,
          ),
          fetchJson<OutlookStatusResponse>(
            `api/v1/clinics/${courseId}/outlook/status`,
          ),
        ]);
        setStaffView(view);
        setOutlook(status);
      } else {
        setStudentView(
          await fetchJson<StudentClinicViewResponse>(
            `api/v1/clinics/${courseId}/${selectedId}/student`,
          ),
        );
      }
    } catch (err) {
      showAlert((err as Error).message, "danger");
    } finally {
      setViewLoading(false);
    }
  }, [courseId, selectedId, isStaff, showAlert]);

  useEffect(() => {
    if (courseRoles.length > 0) void loadList();
  }, [courseRoles, loadList]);

  useEffect(() => {
    if (courseRoles.length > 0) void loadView();
  }, [courseRoles, loadView]);

  if (!user) {
    return <LoadingScreen message="Loading user data..." />;
  }
  if (!courseId || courseRoles.length === 0 || !list) {
    return <LoadingScreen message="Loading clinics..." />;
  }

  const timezone = list.courseTimezone;
  const breadcrumb = {
    items: [
      { label: "Course Home", href: formulateUrl(`dashboard/${courseId}`) },
      { label: "Interview Clinics" },
    ],
  };
  const onChanged = () => {
    void loadList();
    void loadView();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <AppNavbar title={list.courseName} breadcrumb={breadcrumb} />
      <Container className="p-3 mb-5 flex-grow-1">
        <Row className="mb-3 align-items-center">
          <Col>
            <h1>Interview Clinics</h1>
            <p className="text-muted mb-0">
              {isStaff
                ? "Instructors add booked rooms, CAs claim the 30-minute slots they will cover, and project teams sign up for claimed slots."
                : "Sign up your project team for an interview slot. Everyone on your team receives an Outlook invite."}
            </p>
          </Col>
          {list.clinics.length > 0 && (
            <Col xs={12} md={4}>
              <Form.Select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                aria-label="Select clinic"
              >
                {list.clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.projectKey})
                    {c.archivedAt ? " [archived]" : ""}
                  </option>
                ))}
              </Form.Select>
            </Col>
          )}
        </Row>

        {isAdmin && (
          <CreateClinicCard
            courseId={courseId}
            showAlert={showAlert}
            onCreated={(clinic) => {
              setSelectedId(clinic.id);
              void loadList();
            }}
          />
        )}

        {list.clinics.length === 0 && (
          <p className="text-muted">No interview clinics have been scheduled yet.</p>
        )}

        {viewLoading && !staffView && !studentView && (
          <div className="text-center">
            <Spinner animation="border" />
          </div>
        )}

        {selectedId && staffView?.clinic.id === selectedId && (
          <>
            {staffView.clinic.description && (
              <p>{staffView.clinic.description}</p>
            )}
            <OutlookBanner courseId={courseId} status={outlook} />
            {isAdmin && (
              <AdminClinicCard
                courseId={courseId}
                timezone={timezone}
                view={staffView}
                onChanged={onChanged}
                showAlert={showAlert}
              />
            )}
            <StaffSlotsCard
              courseId={courseId}
              timezone={timezone}
              view={staffView}
              viewerNetId={viewerNetId}
              isAdmin={isAdmin}
              canClaim={Boolean(outlook?.connected) && !staffView.clinic.archivedAt}
              onChanged={onChanged}
              showAlert={showAlert}
            />
          </>
        )}

        {selectedId && studentView?.clinic.id === selectedId && (
          <>
            {studentView.clinic.description && (
              <p>{studentView.clinic.description}</p>
            )}
            <StudentClinicView
              courseId={courseId}
              timezone={timezone}
              view={studentView}
              onChanged={onChanged}
              showAlert={showAlert}
            />
          </>
        )}

        <p className="text-muted small mt-3">
          All times shown in the course timezone ({timezone}).
        </p>
      </Container>
    </div>
  );
}
