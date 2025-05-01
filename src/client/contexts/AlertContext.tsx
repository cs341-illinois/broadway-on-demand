import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";
import Alert from "react-bootstrap/Alert";

type AlertItem = {
  id: number;
  message: string;
  variant:
    | "primary"
    | "secondary"
    | "success"
    | "danger"
    | "warning"
    | "info"
    | "light"
    | "dark";
};

type AlertContextType = {
  showAlert: (
    message: string,
    variant?: AlertItem["variant"],
    timeout?: number,
  ) => void;
};

const AlertContext = createContext<AlertContextType | undefined>(undefined);

export const AlertProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  const showAlert = useCallback(
    (
      message: string,
      variant: AlertItem["variant"] = "info",
      timeout = 3000,
    ) => {
      const id = Date.now();
      setAlerts((prev) => [...prev, { id, message, variant }]);

      setTimeout(() => {
        setAlerts((prev) => prev.filter((alert) => alert.id !== id));
      }, timeout);
    },
    [],
  );

  return (
    <AlertContext.Provider value={{ showAlert }}>
      <div style={{ position: "fixed", top: 10, right: 10, zIndex: 9999 }}>
        {alerts.map(({ id, message, variant }) => (
          <Alert key={id} variant={variant} dismissible>
            {message}
          </Alert>
        ))}
      </div>
      {children}
    </AlertContext.Provider>
  );
};

export const useAlert = (): AlertContextType => {
  const context = useContext(AlertContext);
  if (!context) {
    throw new Error("useAlert must be used within an AlertProvider");
  }
  return context;
};
