export interface TaxistaAutorizado {
  nombre: string;
  cedula: string;
  numero_taxista: string;
}

export const LISTA_TAXISTAS: TaxistaAutorizado[] = [
  {
    nombre: "Juan Perez",
    cedula: "001-0000000-1",
    numero_taxista: "TX-001",
  },
  {
    nombre: "Maria Rodriguez",
    cedula: "001-0000000-2",
    numero_taxista: "TX-002",
  },
  {
    nombre: "Yery",
    cedula: "402-2592902-1",
    numero_taxista: "TX-003",
  },
];
