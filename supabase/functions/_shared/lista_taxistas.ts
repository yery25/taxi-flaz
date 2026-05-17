export interface TaxistaAutorizado {
  nombre: string;
  cedula: string;
  numero_taxista: string;
  telefono: string;
}

export const LISTA_TAXISTAS: TaxistaAutorizado[] = [
  {
    nombre: "Brayan",
    cedula: "001-0000000-1",
    numero_taxista: "TX-001",
    telefono: "8295714555",
  },
  {
    nombre: "Yery",
    cedula: "402-2592902-1",
    numero_taxista: "TX-003",
    telefono: "8496540294",
  },
  {
    nombre: "Yesenia Rosario",
    cedula: "450-0010332-4",
    numero_taxista: "F-01",
    telefono: "8099933314",
  },
];
